package main

// The few raw Win32 calls the launcher needs. Nothing else lives here.

import (
	"path/filepath"
	"runtime"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	comdlg32 = windows.NewLazySystemDLL("comdlg32.dll")

	procShowWindow           = user32.NewProc("ShowWindow")
	procReleaseCapture       = user32.NewProc("ReleaseCapture")
	procPostMessage          = user32.NewProc("PostMessageW")
	procMessageBox           = user32.NewProc("MessageBoxW")
	procSetWindowLongPtr     = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos         = user32.NewProc("SetWindowPos")
	procSetWindowRgn         = user32.NewProc("SetWindowRgn")
	procGetDpiForWindow      = user32.NewProc("GetDpiForWindow") // Win10 1607+
	procSystemParametersInfo = user32.NewProc("SystemParametersInfoW")
	procCreateRectRgn        = gdi32.NewProc("CreateRectRgn")
	procCreateRoundRectRgn   = gdi32.NewProc("CreateRoundRectRgn")
	procCombineRgn           = gdi32.NewProc("CombineRgn")
	procDeleteObject         = gdi32.NewProc("DeleteObject")
	procShellExecuteEx       = shell32.NewProc("ShellExecuteExW")
	procGetOpenFileName      = comdlg32.NewProc("GetOpenFileNameW")
)

const (
	swMinimize      = 6
	wmNCLButtonDown = 0xA1
	htCaption       = 2
	mbYesNo         = 0x4
	mbIconError     = 0x10
	idYes           = 6
)

func u16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

func messageBox(text, title string, flags uintptr) int {
	r, _, _ := procMessageBox.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(title))), flags)
	return int(r)
}

func openURL(u string) {
	_ = windows.ShellExecute(0, u16("open"), u16(u), nil, nil, windows.SW_SHOWNORMAL)
}

// makeFrameless drops the native title bar (the HTML draws its own XP one), sizes the
// window for the monitor DPI, centers it and rounds the top corners like XP Luna.
func makeFrameless(hwnd uintptr) {
	dpi := uintptr(96)
	if procGetDpiForWindow.Find() == nil {
		if d, _, _ := procGetDpiForWindow.Call(hwnd); d != 0 {
			dpi = d
		}
	}
	w, h := winW*dpi/96, winH*dpi/96

	const (
		wsPopup, wsVisible, wsClipChildren = 0x80000000, 0x10000000, 0x02000000
		wsSysMenu, wsMinimizeBox           = 0x00080000, 0x00020000
		gwlStyle                           = -16
	)
	style := gwlStyle
	procSetWindowLongPtr.Call(hwnd, uintptr(style), wsPopup|wsVisible|wsClipChildren|wsSysMenu|wsMinimizeBox)

	var work struct{ L, T, R, B int32 }
	procSystemParametersInfo.Call(0x30 /*SPI_GETWORKAREA*/, 0, uintptr(unsafe.Pointer(&work)), 0)
	x := int(work.L) + max(0, int(work.R-work.L)-int(w))/2
	y := int(work.T) + max(0, int(work.B-work.T)-int(h))/2
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), w, h, 0x4|0x20|0x40) // NOZORDER|FRAMECHANGED|SHOWWINDOW

	r := 16 * dpi / 96
	rgn, _, _ := procCreateRoundRectRgn.Call(0, 0, w+1, h+1, r, r)
	bottom, _, _ := procCreateRectRgn.Call(0, h/2, w, h)
	procCombineRgn.Call(rgn, rgn, bottom, 2 /*RGN_OR*/)
	procDeleteObject.Call(bottom)
	procSetWindowRgn.Call(hwnd, rgn, 1) // the window now owns rgn
}

type shellExecuteInfo struct {
	cbSize        uint32
	fMask         uint32
	hwnd          uintptr
	verb          *uint16
	file          *uint16
	params        *uint16
	dir           *uint16
	show          int32
	instApp       uintptr
	idList        uintptr
	class         *uint16
	keyClass      uintptr
	hotKey        uint32
	iconOrMonitor uintptr
	process       windows.Handle
}

// runAsAdmin starts exe elevated (UAC prompt), waits, and returns its exit code.
// A declined prompt returns windows.ERROR_CANCELLED.
func runAsAdmin(exe, params string) (uint32, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	_ = windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE)
	defer windows.CoUninitialize()

	info := shellExecuteInfo{
		fMask:  0x40 | 0x100, // NOCLOSEPROCESS | NOASYNC
		verb:   u16("runas"),
		file:   u16(exe),
		params: u16(params),
		dir:    u16(filepath.Dir(exe)),
		show:   0, // SW_HIDE
	}
	info.cbSize = uint32(unsafe.Sizeof(info))
	if r, _, err := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		return 0, err
	}
	defer windows.CloseHandle(info.process)
	if _, err := windows.WaitForSingleObject(info.process, windows.INFINITE); err != nil {
		return 0, err
	}
	var code uint32
	err := windows.GetExitCodeProcess(info.process, &code)
	return code, err
}

type openFileName struct {
	structSize    uint32
	owner         uintptr
	instance      uintptr
	filter        *uint16
	customFilter  *uint16
	maxCustFilter uint32
	filterIndex   uint32
	file          *uint16
	maxFile       uint32
	fileTitle     *uint16
	maxFileTitle  uint32
	initialDir    *uint16
	title         *uint16
	flags         uint32
	fileOffset    uint16
	fileExtension uint16
	defExt        *uint16
	custData      uintptr
	hook          uintptr
	templateName  *uint16
	reserved      uintptr
	reserved2     uint32
	flagsEx       uint32
}

// openFileDialog shows the classic "Open" dialog for RisingEagle.exe. "" = cancelled.
func openFileDialog(owner uintptr, current string) string {
	filter := utf16.Encode([]rune("RisingEagle.exe\x00RisingEagle*.exe\x00All programs\x00*.exe\x00\x00"))
	buf := make([]uint16, 1024)
	copy(buf[:len(buf)-1], utf16.Encode([]rune(current)))

	ofn := openFileName{
		owner:   owner,
		filter:  &filter[0],
		file:    &buf[0],
		maxFile: uint32(len(buf)),
		title:   u16("Choose RisingEagle.exe"),
		flags:   0x1000 | 0x800 | 0x8 | 0x80000, // FILEMUSTEXIST|PATHMUSTEXIST|NOCHANGEDIR|EXPLORER
	}
	if current != "" {
		ofn.initialDir = u16(filepath.Dir(current))
	}
	ofn.structSize = uint32(unsafe.Sizeof(ofn))
	if r, _, _ := procGetOpenFileName.Call(uintptr(unsafe.Pointer(&ofn))); r == 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}
