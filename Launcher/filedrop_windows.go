package main

// Drag & drop of files from Explorer.
//
// A web page never sees a dropped file's full path, only its name. WebView2 can hand
// the path to the host: the page calls
//   chrome.webview.postMessageWithAdditionalObjects("rising2:drop", [file])
// and the host reads ICoreWebView2File.Path from the message. go-webview2 does not
// wrap that, so we register our own WebMessageReceived handler with raw COM calls.
// Method slots come from WebView2.h (SDK 1.0.2903.40); they never change for an
// existing interface.

import (
	"encoding/json"
	"reflect"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

const dropMessage = "rising2:drop"

var iidWebMessageArgs2 = windows.GUID{Data1: 0x06fc7ab7, Data2: 0xc90c, Data3: 0x4297,
	Data4: [8]byte{0x93, 0x89, 0x33, 0xca, 0x01, 0xcf, 0x6d, 0x5e}}
var iidWebView2File = windows.GUID{Data1: 0xf2c19559, Data2: 0x6bc1, Data3: 0x4583,
	Data4: [8]byte{0xa7, 0x57, 0x90, 0x02, 0x1b, 0xe9, 0xaf, 0xec}}

// comCall calls method number slot of the COM object obj (a pointer owned by WebView2).
func comCall(obj unsafe.Pointer, slot int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vtbl, slot*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func comRelease(obj unsafe.Pointer) { comCall(obj, 2) }

func ptr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

// dropHandler is a minimal COM object implementing ICoreWebView2WebMessageReceivedEventHandler.
type dropHandler struct{ vtbl *[4]uintptr }

var onDropPath func(path string) // set by enableFileDrop

var (
	dropVtbl = [4]uintptr{
		windows.NewCallback(func(this unsafe.Pointer, iid unsafe.Pointer, out *unsafe.Pointer) uintptr { // QueryInterface
			*out = this
			return 0
		}),
		windows.NewCallback(func(this unsafe.Pointer) uintptr { return 1 }), // AddRef (object lives forever)
		windows.NewCallback(func(this unsafe.Pointer) uintptr { return 1 }), // Release
		windows.NewCallback(dropInvoke),                                     // Invoke(sender, args)
	}
	theDropHandler = &dropHandler{vtbl: &dropVtbl} // global: COM keeps a pointer to it
)

func dropInvoke(this, sender, args unsafe.Pointer) uintptr {
	var args2 unsafe.Pointer
	if comCall(args, 0, ptr(&iidWebMessageArgs2), ptr(&args2)) != 0 || args2 == nil {
		return 0 // runtime too old for additional objects
	}
	defer comRelease(args2)

	var msg *uint16
	if comCall(args2, 5, ptr(&msg)) != 0 || msg == nil {
		return 0 // not a string message
	}
	text := windows.UTF16PtrToString(msg)
	windows.CoTaskMemFree(unsafe.Pointer(msg))
	if text != dropMessage {
		return 0
	}

	var objs unsafe.Pointer
	if comCall(args2, 6, ptr(&objs)) != 0 || objs == nil {
		return 0
	}
	defer comRelease(objs)
	var count uint32
	comCall(objs, 3, ptr(&count))
	for i := uint32(0); i < count; i++ {
		var item, file unsafe.Pointer
		if comCall(objs, 4, uintptr(i), ptr(&item)) != 0 || item == nil {
			continue
		}
		ok := comCall(item, 0, ptr(&iidWebView2File), ptr(&file)) == 0 && file != nil
		comRelease(item)
		if !ok {
			continue
		}
		var p *uint16
		comCall(file, 3, ptr(&p))
		comRelease(file)
		if p != nil {
			path := windows.UTF16PtrToString(p)
			windows.CoTaskMemFree(unsafe.Pointer(p))
			onDropPath(path)
			return 0 // first file only
		}
	}
	return 0
}

// enableFileDrop makes dropped files reach the page as full paths via window.__dropped(path).
// go-webview2 keeps its Chromium object in an unexported field, so we read it with reflect.
func enableFileDrop(w webview2.WebView) bool {
	f := reflect.ValueOf(w).Elem().FieldByName("browser")
	if !f.IsValid() {
		return false
	}
	chromium, ok := reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem().Interface().(*edge.Chromium)
	if !ok || chromium.GetController() == nil {
		return false
	}
	controller := unsafe.Pointer(chromium.GetController())
	var core unsafe.Pointer
	if comCall(controller, 25, ptr(&core)) != 0 || core == nil { // get_CoreWebView2
		return false
	}
	defer comRelease(core)

	onDropPath = func(path string) {
		if IsLnk(path) { // a shortcut: use the file it points to
			if target, err := ResolveLnk(path); err == nil {
				path = target
			}
		}
		b, _ := json.Marshal(path)
		w.Eval("window.__dropped && window.__dropped(" + string(b) + ")")
	}
	var token int64
	return comCall(core, 34, ptr(theDropHandler), ptr(&token)) == 0 // add_WebMessageReceived
}
