//go:build windows

package main

import (
	"os"
	"syscall"
)

// 不共享打开：其他进程打开时返回 ERROR_SHARING_VIOLATION，句柄随进程退出由系统关闭。
func lockRuntimeGuard(path string) (*os.File, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}
