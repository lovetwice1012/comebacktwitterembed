#ifndef FIXTURE_LIBPROC_H
#define FIXTURE_LIBPROC_H
#include <stdint.h>
#define PROC_PIDPATHINFO_MAXSIZE 4096
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);
int proc_pidpath(int pid, void *buffer, uint32_t buffersize);
int proc_listchildpids(pid_t ppid, void *buffer, int buffersize);
int proc_pidfdinfo(int pid, int fd, int flavor, void *buffer, int buffersize);
#endif
