/* peakrss PROGRAM ARGS...: runs PROGRAM with its output passed through and
 * prints its peak resident memory (ru_maxrss) to stderr as "peak-rss-kib N".
 * The box has no /usr/bin/time; this is the same measurement. */
#include <stdio.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: peakrss program [args...]\n");
    return 2;
  }
  pid_t pid = fork();
  if (pid < 0) return 2;
  if (pid == 0) {
    execvp(argv[1], argv + 1);
    perror(argv[1]);
    _exit(127);
  }
  int status = 0;
  struct rusage usage;
  if (wait4(pid, &status, 0, &usage) < 0) return 2;
  fprintf(stderr, "peak-rss-kib %ld\n", usage.ru_maxrss);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
}
