/* Debug tool: print the rows of a list view in another (32-bit) process.
 * Usage: lvdump PID [CONTROL_ID=1010]
 * The LVITEM and text buffer must live in the target process, so they are
 * allocated there with VirtualAllocEx. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static DWORD g_pid; static int g_id; static HWND g_lv;

static BOOL CALLBACK child_cb(HWND h, LPARAM lp)
{
    (void)lp;
    if (GetDlgCtrlID(h) == g_id) { char c[32]; GetClassNameA(h, c, 32); if (!strcmp(c, "SysListView32")) { g_lv = h; return FALSE; } }
    return TRUE;
}
static BOOL CALLBACK top_cb(HWND h, LPARAM lp)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    if (pid == g_pid) EnumChildWindows(h, child_cb, lp);
    return g_lv == NULL;
}

int main(int argc, char **argv)
{
    HANDLE proc;
    char *rbuf;
    LVITEMA *ritem;
    int rows, cols = 2, r, c;
    if (argc < 2) { printf("usage: lvdump PID [ID]\n"); return 1; }
    g_pid = atoi(argv[1]); g_id = argc > 2 ? atoi(argv[2]) : 1010;
    EnumWindows(top_cb, 0);
    if (!g_lv) { printf("list view %d not found\n", g_id); return 1; }
    proc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE, FALSE, g_pid);
    ritem = VirtualAllocEx(proc, NULL, sizeof(LVITEMA) + 512, MEM_COMMIT, PAGE_READWRITE);
    rbuf = (char *)ritem + sizeof(LVITEMA);
    rows = (int)SendMessageA(g_lv, LVM_GETITEMCOUNT, 0, 0);
    for (r = 0; r < rows; r++) {
        printf("%2d", r);
        for (c = 0; c < cols; c++) {
            LVITEMA it; char text[512] = ""; SIZE_T n;
            memset(&it, 0, sizeof it);
            it.mask = LVIF_TEXT; it.iItem = r; it.iSubItem = c; it.pszText = rbuf; it.cchTextMax = 511;
            WriteProcessMemory(proc, ritem, &it, sizeof it, &n);
            SendMessageA(g_lv, LVM_GETITEMTEXTA, r, (LPARAM)ritem);
            ReadProcessMemory(proc, rbuf, text, 511, &n);
            text[511] = 0;
            printf(" | %s", text);
        }
        printf("\n");
    }
    VirtualFreeEx(proc, ritem, 0, MEM_RELEASE);
    return 0;
}
