package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mediaAccount struct {
	id               string
	provider, config object
	balance          any
	revision         int
	listeners        map[chan object]bool
}

var accountMu sync.Mutex
var mediaAccounts = map[string]*mediaAccount{}
var accountSecret = func() []byte { secret := make([]byte, 32); _, _ = rand.Read(secret); return secret }()

func accountSnapshot(account *mediaAccount) object {
	return object{"accountId": account.id, "balance": clone(account.balance), "revision": account.revision}
}
func mediaAccountID(provider, config object) string {
	data, _ := json.Marshal(object{"id": provider["id"], "config": config})
	h := hmac.New(sha256.New, accountSecret)
	_, _ = h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
func (s *server) refreshBalance(ctx context.Context, provider, config object) (object, error) {
	id := mediaAccountID(provider, config)
	accountMu.Lock()
	account := mediaAccounts[id]
	if account == nil {
		account = &mediaAccount{id: id, provider: provider, config: config, listeners: map[chan object]bool{}}
		mediaAccounts[id] = account
	}
	accountMu.Unlock()
	if str(provider["id"]) != "tfRouter" {
		accountMu.Lock()
		defer accountMu.Unlock()
		return accountSnapshot(account), nil
	}
	result, err := providerJSON(ctx, providerBase(provider, config), "balance", config, nil)
	if err != nil {
		return nil, err
	}
	balance := asObject(result["data"])
	if balance["unit"] == nil {
		balance["unit"] = "元"
	}
	for _, key := range []string{"balance", "keyBalance", "totalConsumption", "totalRecharge"} {
		if value, ok := balance[key].(string); ok {
			if parsed, err := strconv.ParseFloat(value, 64); err == nil {
				balance[key] = parsed
			}
		}
	}
	if _, ok := balance["balance"].(float64); !ok {
		return nil, fail(502, "供应商余额响应格式无效")
	}
	accountMu.Lock()
	defer accountMu.Unlock()
	account.balance = balance
	account.revision++
	snapshot := accountSnapshot(account)
	for listener := range account.listeners {
		select {
		case listener <- snapshot:
		default:
		}
	}
	return snapshot, nil
}
func (s *server) balanceEvents(w http.ResponseWriter, r *http.Request) error {
	if !s.sameOrigin(r) {
		return fail(403, "只允许同源余额通知")
	}
	ids := strings.Split(r.URL.Query().Get("accountIds"), ",")
	if len(ids) < 1 || len(ids) > 100 {
		return fail(400, "余额账户数量无效")
	}
	listener := make(chan object, 100)
	accountMu.Lock()
	accounts := []*mediaAccount{}
	for _, id := range ids {
		account := mediaAccounts[id]
		if account == nil {
			accountMu.Unlock()
			return fail(404, "余额账户已失效，请刷新余额")
		}
		accounts = append(accounts, account)
	}
	for _, account := range accounts {
		account.listeners[listener] = true
		listener <- accountSnapshot(account)
	}
	accountMu.Unlock()
	defer func() {
		accountMu.Lock()
		defer accountMu.Unlock()
		for _, account := range accounts {
			delete(account.listeners, listener)
		}
	}()
	flusher, ok := w.(http.Flusher)
	if !ok {
		return fail(500, "HTTP 流式响应不可用")
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	timer := time.NewTicker(20 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil
		case event := <-listener:
			bytes, _ := json.Marshal(event)
			if _, err := fmt.Fprintf(w, "data: %s\n\n", bytes); err != nil {
				return nil
			}
			flusher.Flush()
		case <-timer.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return nil
			}
			flusher.Flush()
		}
	}
}
