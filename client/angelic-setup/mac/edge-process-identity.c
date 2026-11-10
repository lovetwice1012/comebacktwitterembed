/*
 * Read the start time of the Edge process started directly by our parent.
 * This does not inspect browser data, open network connections or modify any
 * process. A separate OS-backed socket ownership check is still required.
 */
#include <sys/types.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <unistd.h>
#include <stdint.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char expected_path[] = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";

int main(int argc, char **argv) {
    if (argc != 2 || !argv[1][0] || strlen(argv[1]) > 10 || argv[1][0] == '0') return 2;
    for (const char *p = argv[1]; *p; p++) if (*p < '0' || *p > '9') return 2;
    char *end = NULL;
    unsigned long value = strtoul(argv[1], &end, 10);
    if (!end || *end || value <= 4 || value > INT_MAX) return 2;
    int pid = (int)value;
    struct proc_bsdinfo info;
    memset(&info, 0, sizeof(info));
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)
        || info.pbi_pid != (uint32_t)pid || info.pbi_ppid != (uint32_t)getppid()
        || info.pbi_uid != getuid() || !info.pbi_start_tvsec || info.pbi_start_tvusec >= 1000000) return 2;
    char executable[PROC_PIDPATHINFO_MAXSIZE];
    memset(executable, 0, sizeof(executable));
    if (proc_pidpath(pid, executable, sizeof(executable)) <= 0 || !memchr(executable, '\0', sizeof(executable))
        || strcmp(executable, expected_path)) return 2;
    if (printf("%llu:%06llu\n", (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec) < 0) return 2;
    return 0;
}
