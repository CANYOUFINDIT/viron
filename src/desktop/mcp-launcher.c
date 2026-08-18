#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable_path[PATH_MAX];
  uint32_t executable_path_size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
    fputs("Viron MCP launcher path is too long\n", stderr);
    return 1;
  }

  char resolved_path[PATH_MAX];
  if (realpath(executable_path, resolved_path) == NULL) {
    if (snprintf(resolved_path, sizeof(resolved_path), "%s", executable_path) >= (int)sizeof(resolved_path)) {
      fputs("Viron MCP launcher path is too long\n", stderr);
      return 1;
    }
  }
  char *separator = strrchr(resolved_path, '/');
  if (separator == NULL) {
    fputs("Viron MCP launcher directory is invalid\n", stderr);
    return 1;
  }
  *separator = '\0';

  char viron_path[PATH_MAX];
  char stdio_path[PATH_MAX];
  if (snprintf(viron_path, sizeof(viron_path), "%s/Viron", resolved_path) >= (int)sizeof(viron_path)
      || snprintf(stdio_path, sizeof(stdio_path), "%s/../Resources/app.asar/dist/desktop/mcp-stdio.js", resolved_path) >= (int)sizeof(stdio_path)) {
    fputs("Viron MCP packaged path is too long\n", stderr);
    return 1;
  }
  if (setenv("ELECTRON_RUN_AS_NODE", "1", 1) != 0) {
    perror("Viron MCP could not configure Electron Node mode");
    return 1;
  }

  char **child_argv = calloc((size_t)argc + 2, sizeof(char *));
  if (child_argv == NULL) {
    fputs("Viron MCP launcher could not allocate arguments\n", stderr);
    return 1;
  }
  child_argv[0] = viron_path;
  child_argv[1] = stdio_path;
  for (int index = 1; index < argc; index += 1) child_argv[index + 1] = argv[index];
  child_argv[argc + 1] = NULL;
  execv(viron_path, child_argv);
  perror("Viron MCP launcher could not start Viron");
  free(child_argv);
  return 1;
}
