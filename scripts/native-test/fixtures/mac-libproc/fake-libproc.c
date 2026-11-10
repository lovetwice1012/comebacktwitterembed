#include <sys/proc_info.h>
#include <libproc.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>

int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize) {
    (void)flavor; (void)arg;
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    if (mode && !strcmp(mode, "missing")) return 0;
    if (buffersize != (int)sizeof(struct proc_bsdinfo)) return 0;
    struct proc_bsdinfo *info = buffer;
    info->pbi_pid = (uint32_t)pid; info->pbi_ppid = (uint32_t)getppid(); info->pbi_uid = getuid();
    info->pbi_start_tvsec = 1700000000; info->pbi_start_tvusec = 123456;
    if (mode && !strcmp(mode, "pid")) info->pbi_pid++;
    if (mode && !strcmp(mode, "parent")) info->pbi_ppid++;
    if (mode && !strcmp(mode, "user")) info->pbi_uid++;
    if (mode && !strcmp(mode, "seconds")) info->pbi_start_tvsec = 0;
    if (mode && !strcmp(mode, "microseconds")) info->pbi_start_tvusec = 1000000;
    return (int)sizeof(*info);
}
int proc_pidpath(int pid, void *buffer, uint32_t buffersize) {
    (void)pid;
    const char *mode = getenv("MAC_IDENTITY_TEST_CASE");
    const char *value = mode && !strcmp(mode, "path") ? "/tmp/untrusted" : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    if (strlen(value) + 1 > buffersize) return 0;
    memcpy(buffer, value, strlen(value) + 1); return (int)strlen(value);
}
