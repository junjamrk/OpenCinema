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
	"math"
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
	tasks            map[string]bool // 进行中的任务 ID，值表示窗口内是否与其他任务重叠
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
func mediaAccountFor(provider, config object) *mediaAccount {
	id := mediaAccountID(provider, config)
	accountMu.Lock()
	defer accountMu.Unlock()
	account := mediaAccounts[id]
	if account == nil {
		account = &mediaAccount{id: id, provider: provider, config: config, listeners: map[chan object]bool{}, tasks: map[string]bool{}}
		mediaAccounts[id] = account
	}
	return account
}
func (s *server) refreshBalance(ctx context.Context, provider, config object) (object, error) {
	account := mediaAccountFor(provider, config)
	if !boolean(provider["supportsBalance"]) {
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

// 任务成本分两项记录，互不回填：estimate 是提交前的报价，actual 是结束后的实际扣费，拿不到就是 null。
// ACT: 只有 TF-router 有报价和余额接口，其他供应商两项都是 null。实际扣费优先取厂商在任务结果里的返回，
// 否则取余额差；余额差只能归属到窗口内唯一的任务，所以同账户任务重叠、期间充值或余额没变都记未知。
// 上限是本进程看不到同账户在其他设备上的消费，也看不到延迟入账；升级方式是由厂商在任务结果里返回扣费。
func (s *server) beginMediaCost(ctx context.Context, id string, task *mediaTask) (func(bool), error) {
	provider, config, err := s.provider(str(task.request["providerId"]))
	if err != nil || !boolean(provider["supportsPrice"]) {
		return func(bool) {}, nil
	}
	account := mediaAccountFor(provider, config)
	accountMu.Lock()
	for other := range account.tasks {
		account.tasks[other] = true
	}
	account.tasks[id] = len(account.tasks) > 0
	accountMu.Unlock()
	// 报价是 POST，不能标记任务已提交，否则报价失败会把未派发的任务变成未确认。
	probe, cancel := context.WithTimeout(context.WithValue(ctx, mediaSubmissionKey{}, nil), 15*time.Second)
	defer cancel()
	cost := object{}
	if price, err := s.mediaPrice(probe, task.directory, provider, config, task.request); err == nil && strings.TrimSpace(str(asObject(price)["price"])) != "" {
		cost["estimate"] = object{"price": asObject(price)["price"], "tips": str(asObject(price)["tips"])}
	}
	var before object
	if snapshot, err := s.refreshBalance(probe, provider, config); err == nil {
		before = asObject(snapshot["balance"])
	}
	finish := func(succeeded bool) {
		var after object
		s.tasksMu.Lock()
		reported := task.cost["actual"] != nil
		s.tasksMu.Unlock()
		// 读完余额才退出窗口：刚好在此时开始的任务也算重叠。
		if succeeded && !reported && before != nil {
			deadline, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if snapshot, err := s.refreshBalance(deadline, provider, config); err == nil {
				after = asObject(snapshot["balance"])
			}
		}
		accountMu.Lock()
		overlapped := account.tasks[id]
		delete(account.tasks, id)
		accountMu.Unlock()
		if actual := balanceDeduction(before, after); actual != nil && !overlapped {
			s.tasksMu.Lock()
			task.cost["actual"] = actual
			s.tasksMu.Unlock()
		}
	}
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	task.cost = cost
	return finish, s.saveMediaTask(id, task, false)
}
func balanceDeduction(before, after object) object {
	if before == nil || after == nil || before["unit"] != after["unit"] || number(before["totalRecharge"]) != number(after["totalRecharge"]) {
		return nil
	}
	spent := number(before["balance"]) - number(after["balance"])
	if spent <= 0 || math.IsInf(spent, 0) {
		return nil
	}
	return object{"amount": math.Round(spent*1e6) / 1e6, "unit": after["unit"], "source": "balanceDelta"}
}

// recordVendorCost 只收厂商明确返回且带单位的金额，字段不全就当没有，不推算。
// ACT: cost、amount、unit 这几个字段名没有 TF-router 公开文档可核对。字段不符时只是读不到，回退到余额差，不会记错金额；
// 升级方式是拿到真实响应或接口文档后改成确定的字段名。
func recordVendorCost(ctx context.Context, data object) {
	value, _ := ctx.Value(videoTaskKey{}).(*videoTaskContext)
	if value == nil || str(data["unit"]) == "" {
		return
	}
	for _, key := range []string{"cost", "amount"} {
		amount, err := strconv.ParseFloat(fmt.Sprint(data[key]), 64)
		if err == nil && amount >= 0 && !math.IsInf(amount, 0) {
			value.server.tasksMu.Lock()
			defer value.server.tasksMu.Unlock()
			if value.task.cost != nil {
				value.task.cost["actual"] = object{"amount": amount, "unit": data["unit"], "source": "vendor"}
			}
			return
		}
	}
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
