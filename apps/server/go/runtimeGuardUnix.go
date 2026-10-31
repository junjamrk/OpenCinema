//go:build !windows

package main

import (
	"os"
	"syscall"
)

// ACT: 文件系统不支持 flock 时按无法独占拒绝启动，不退回到无保护的目录锁。
func lockRuntimeGuard(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
