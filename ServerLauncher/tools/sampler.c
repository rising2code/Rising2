/* Debug tool: sample the busiest thread of a process. Prints a histogram of
 * EIP values and of the 8 dwords on top of the stack (return-address hints).
 * Usage: sampler PID [samples] */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { DWORD v; int n; } Bin;
static Bin eips[4096]; static int neip;
static Bin rets[8192]; static int nret;

static void add(Bin *b, int *n, int max, DWORD v)
{
    int i;
    for (i = 0; i < *n; i++) if (b[i].v == v) { b[i].n++; return; }
    if (*n < max) { b[*n].v = v; b[*n].n = 1; (*n)++; }
}
static int cmp(const void *a, const void *b) { return ((const Bin *)b)->n - ((const Bin *)a)->n; }

int main(int argc, char **argv)
{
    DWORD pid = atoi(argv[1]), best = 0;
    int samples = argc > 2 ? atoi(argv[2]) : 500, i;
    ULONGLONG bestt = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0), proc, th;
    THREADENTRY32 te; te.dwSize = sizeof te;
    for (BOOL ok = Thread32First(snap, &te); ok; ok = Thread32Next(snap, &te)) {
        FILETIME a, b, k, u;
        if (te.th32OwnerProcessID != pid) continue;
        th = OpenThread(THREAD_QUERY_INFORMATION, FALSE, te.th32ThreadID);
        if (th && GetThreadTimes(th, &a, &b, &k, &u)) {
            ULONGLONG t = ((ULONGLONG)u.dwHighDateTime << 32 | u.dwLowDateTime) + ((ULONGLONG)k.dwHighDateTime << 32 | k.dwLowDateTime);
            printf("thread %lu cpu %.2fs\n", te.th32ThreadID, t / 1e7);
            if (t > bestt) { bestt = t; best = te.th32ThreadID; }
        }
        if (th) CloseHandle(th);
    }
    proc = OpenProcess(PROCESS_VM_READ, FALSE, pid);
    th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, best);
    printf("sampling thread %lu\n", best);
    for (i = 0; i < samples; i++) {
        CONTEXT c; DWORD stk[8]; SIZE_T got = 0; int j;
        c.ContextFlags = CONTEXT_CONTROL;
        SuspendThread(th);
        if (GetThreadContext(th, &c)) {
            add(eips, &neip, 4096, c.Eip);
            if (ReadProcessMemory(proc, (void *)c.Esp, stk, sizeof stk, &got))
                for (j = 0; j < 8; j++) if (stk[j] >= 0x400000 && stk[j] < 0x80000000) add(rets, &nret, 8192, stk[j]);
        }
        ResumeThread(th);
        Sleep(7);
    }
    qsort(eips, neip, sizeof eips[0], cmp); qsort(rets, nret, sizeof rets[0], cmp);
    printf("top EIP:\n"); for (i = 0; i < 25 && i < neip; i++) printf("  %08lx %d\n", eips[i].v, eips[i].n);
    printf("top stack values:\n"); for (i = 0; i < 25 && i < nret; i++) printf("  %08lx %d\n", rets[i].v, rets[i].n);
    return 0;
}
