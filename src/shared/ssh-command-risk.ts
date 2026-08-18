import type { McpRiskLevel } from "./mcp-settings.js";

type ShellToken =
  | { kind: "word"; value: string }
  | { kind: "separator"; value: string }
  | { kind: "redirect"; value: string };

const SIMPLE_QUERY_COMMANDS = new Set([
  ":", "arch", "basename", "cal", "cat", "cksum", "column", "comm", "cut", "df",
  "dirname", "du", "echo", "expand", "file", "findmnt", "fmt", "fold", "free", "getconf", "getent",
  "grep", "egrep", "fgrep", "groups", "head", "hexdump", "host", "id", "iostat", "ipcs", "last", "lastlog", "less", "locale",
  "locate", "logname", "ls", "lsattr", "lsblk", "lscpu", "lsof", "md5sum", "more", "mpstat", "netstat",
  "nl", "nproc", "nslookup", "numfmt", "od", "paste", "pgrep", "pidof", "ping", "pr", "printenv",
  "printf", "ps", "pstree", "pwd", "readlink", "realpath", "rev", "sar", "seq", "sha1sum", "sha224sum", "sha256sum",
  "sha384sum", "sha512sum", "size", "ss", "stat", "strings", "tac", "tail", "top", "tr", "traceroute",
  "true", "uname", "unexpand", "uniq", "uptime", "users", "vmstat", "w", "wc", "whatis", "whereis", "which",
  "who", "whoami", "whois", "zipinfo",
]);

const FORBIDDEN_ASSIGNMENTS = /^(?:PATH|CDPATH|ENV|BASH_ENV|SHELLOPTS|IFS|GLOBIGNORE|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*)$/i;
const SAFE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

function basename(command: string): string | null {
  if (!command.includes("/")) return command;
  if (!/^\/(?:usr\/)?s?bin\/[^/]+$/.test(command)) return null;
  return command.slice(command.lastIndexOf("/") + 1);
}

function commandSubstitution(source: string, start: number): { body: string; end: number } | null {
  let depth = 1;
  let quote: "single" | "double" | null = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'") {
      if (quote !== "double") quote = "single";
      continue;
    }
    if (character === "\"") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { body: source.slice(start + 2, index), end: index };
    }
  }
  return null;
}

function backtickSubstitution(source: string, start: number): { body: string; end: number } | null {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "`") return { body: source.slice(start + 1, index), end: index };
  }
  return null;
}

function redirectionAt(source: string, start: number): string | null {
  return source.slice(start).match(/^(?:&>>?|(?:\d+)?(?:<<<|<<|<>|>>|>\||<|>)(?:&(?:\d+|-))?)/)?.[0] ?? null;
}

function tokenizeShell(source: string, depth: number): ShellToken[] | null {
  if (depth > 6) return null;
  const tokens: ShellToken[] = [];
  let word = "";
  let quote: "single" | "double" | null = null;
  const flushWord = () => {
    if (!word) return;
    tokens.push({ kind: "word", value: word });
    word = "";
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "single") {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= source.length) return null;
      word += source[index + 1];
      index += 1;
      continue;
    }
    if (character === "'") {
      if (quote === "double") word += character;
      else quote = "single";
      continue;
    }
    if (character === "\"") {
      quote = quote === "double" ? null : "double";
      continue;
    }
    if (character === "$" && source[index + 1] === "(") {
      const substitution = commandSubstitution(source, index);
      if (!substitution || !isReadOnlyShell(substitution.body, depth + 1)) return null;
      word += "$()";
      index = substitution.end;
      continue;
    }
    if (character === "`") {
      const substitution = backtickSubstitution(source, index);
      if (!substitution || !isReadOnlyShell(substitution.body, depth + 1)) return null;
      word += "$()";
      index = substitution.end;
      continue;
    }
    if (quote === "double") {
      word += character;
      continue;
    }
    if (character === "#" && !word) {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      flushWord();
      if (character === "\n") tokens.push({ kind: "separator", value: ";" });
      continue;
    }
    const redirection = redirectionAt(source, index);
    if (redirection) {
      flushWord();
      tokens.push({ kind: "redirect", value: redirection });
      index += redirection.length - 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (["&&", "||", "|&"].includes(pair)) {
      flushWord();
      tokens.push({ kind: "separator", value: pair });
      index += 1;
      continue;
    }
    if ([";", "|"].includes(character)) {
      flushWord();
      tokens.push({ kind: "separator", value: character });
      continue;
    }
    if (["&", "(", ")"].includes(character)) return null;
    word += character;
  }
  if (quote) return null;
  flushWord();
  return tokens;
}

function optionPresent(arguments_: string[], short: string, long: string): boolean {
  return arguments_.some((argument) => argument === long || argument.startsWith(`${long}=`)
    || (argument.startsWith("-") && !argument.startsWith("--") && argument.slice(1).includes(short)));
}

function unwrapWithOptions(arguments_: string[], optionsWithValue: Set<string>): string[] | null {
  let index = 0;
  while (index < arguments_.length) {
    const argument = arguments_[index];
    if (argument === "--") return arguments_.slice(index + 1);
    if (!argument.startsWith("-") || argument === "-") return arguments_.slice(index);
    const option = argument.split("=", 1)[0];
    if (optionsWithValue.has(option) && !argument.includes("=")) index += 1;
    index += 1;
  }
  return null;
}

function readOnlySystemctl(arguments_: string[]): boolean {
  const allowed = new Set([
    "status", "show", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-sockets",
    "list-timers", "list-dependencies", "get-default", "get-property", "help", "cat",
  ]);
  return arguments_.some((argument) => allowed.has(argument))
    && !arguments_.some((argument) => /^(?:start|stop|restart|reload|enable|disable|mask|unmask|kill|set-|edit|link|revert|daemon-reload|poweroff|reboot|suspend|hibernate|rescue|emergency)$/.test(argument));
}

function readOnlyKubectl(arguments_: string[], depth: number): boolean {
  const command = unwrapWithOptions(arguments_, new Set([
    "-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "--request-timeout", "-s", "--server",
    "--token", "--as", "--as-group", "--cache-dir", "--certificate-authority", "--client-certificate", "--client-key",
    "--tls-server-name", "-v", "--vmodule",
  ]));
  const subcommand = command?.[0];
  if (!command || !subcommand) return false;
  if (subcommand === "exec") {
    const delimiter = command.indexOf("--", 1);
    return delimiter >= 0 && isReadOnlySimple(command.slice(delimiter + 1), depth + 1);
  }
  if (subcommand === "config") return ["current-context", "get-contexts", "view"].includes(command[1] ?? "");
  if (subcommand === "auth") return command[1] === "can-i";
  if (subcommand === "cluster-info") return command[1] !== "dump";
  return new Set(["api-resources", "api-versions", "describe", "diff", "events", "explain", "get", "logs", "options", "top", "version", "wait"]).has(subcommand);
}

function readOnlyContainerCommand(arguments_: string[], depth: number): boolean {
  const topLevel = new Set(["ps", "images", "inspect", "logs", "stats", "top", "version", "info", "events", "diff", "history"]);
  const subcommand = arguments_.find((argument) => !argument.startsWith("-"));
  if (!subcommand) return false;
  if (topLevel.has(subcommand)) return true;
  if (["container", "image", "network", "volume"].includes(subcommand)) {
    const action = arguments_.slice(arguments_.indexOf(subcommand) + 1).find((argument) => !argument.startsWith("-"));
    return action !== undefined && new Set(["ls", "inspect", "logs", "stats", "top", "diff", "history"]).has(action);
  }
  if (subcommand !== "exec") return false;
  const afterExec = arguments_.slice(arguments_.indexOf("exec") + 1);
  const afterOptions = unwrapWithOptions(afterExec, new Set(["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file"]));
  if (!afterOptions || afterOptions.length < 2) return false;
  return isReadOnlySimple(afterOptions.slice(1), depth + 1);
}

function readOnlyGit(arguments_: string[]): boolean {
  const mutating = new Set(["add", "am", "apply", "bisect", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "fetch", "gc", "init", "merge", "mv", "pull", "push", "rebase", "remote", "reset", "restore", "revert", "rm", "stash", "switch", "tag", "worktree"]);
  const allowed = new Set(["annotate", "blame", "cat-file", "count-objects", "describe", "diff", "diff-tree", "for-each-ref", "grep", "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "name-rev", "reflog", "rev-list", "rev-parse", "shortlog", "show", "show-ref", "status", "version"]);
  const afterOptions = unwrapWithOptions(arguments_, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]));
  const command = afterOptions?.[0];
  return command !== undefined && allowed.has(command) && !mutating.has(command);
}

function readOnlyCurl(arguments_: string[]): boolean {
  const forbidden = ["d", "F", "T", "o", "O"];
  if (forbidden.some((short) => optionPresent(arguments_, short, "--__unused__"))) return false;
  if (arguments_.some((argument) => /^(?:--data|--form|--upload-file|--output|--remote-name|--cookie-jar|--netrc-file|--config)(?:=|$)/.test(argument))) return false;
  const requestIndex = arguments_.findIndex((argument) => argument === "-X" || argument === "--request");
  if (requestIndex >= 0 && !/^(?:GET|HEAD)$/i.test(arguments_[requestIndex + 1] ?? "")) return false;
  const inlineRequest = arguments_.find((argument) => /^-X.+/.test(argument) || /^--request=/.test(argument));
  return !inlineRequest || /^(?:-X|--request=)(?:GET|HEAD)$/i.test(inlineRequest);
}

function isReadOnlySimple(words: string[], depth: number): boolean {
  if (depth > 6) return false;
  let index = 0;
  while (words[index] === "!") index += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
    const name = words[index].slice(0, words[index].indexOf("="));
    if (FORBIDDEN_ASSIGNMENTS.test(name)) return false;
    index += 1;
  }
  if (index >= words.length) return true;
  const resolvedCommand = basename(words[index]);
  if (!resolvedCommand) return false;
  const command = resolvedCommand.toLowerCase();
  const arguments_ = words.slice(index + 1);

  if (SIMPLE_QUERY_COMMANDS.has(command)) return true;
  if (["test", "[", "[["].includes(command)) return true;
  if (["cd", "pushd", "popd"].includes(command)) return arguments_.length <= 1;
  if (command === "command") {
    if (["-v", "-V"].includes(arguments_[0] ?? "")) return true;
    const nested = unwrapWithOptions(arguments_, new Set());
    return Boolean(nested?.length) && isReadOnlySimple(nested!, depth + 1);
  }
  if (command === "env") {
    const nested = unwrapWithOptions(arguments_, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
    if (!nested) return true;
    let nestedIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(nested[nestedIndex] ?? "")) {
      const name = nested[nestedIndex].slice(0, nested[nestedIndex].indexOf("="));
      if (FORBIDDEN_ASSIGNMENTS.test(name)) return false;
      nestedIndex += 1;
    }
    return nestedIndex >= nested.length || isReadOnlySimple(nested.slice(nestedIndex), depth + 1);
  }
  if (["sudo", "doas"].includes(command)) {
    const nested = unwrapWithOptions(arguments_, new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-R", "--chroot", "-T", "--command-timeout"]));
    return Boolean(nested?.length) && isReadOnlySimple(nested!, depth + 1);
  }
  if (command === "timeout") {
    const nested = unwrapWithOptions(arguments_, new Set(["-k", "--kill-after", "-s", "--signal"]));
    return Boolean(nested && nested.length > 1) && isReadOnlySimple(nested!.slice(1), depth + 1);
  }
  if (["sh", "bash", "dash", "zsh"].includes(command)) {
    const scriptIndex = arguments_.findIndex((argument) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument));
    return scriptIndex >= 0 && arguments_[scriptIndex + 1] !== undefined && isReadOnlyShell(arguments_[scriptIndex + 1], depth + 1);
  }
  if (["kubectl", "oc"].includes(command)) return readOnlyKubectl(arguments_, depth);
  if (["docker", "podman"].includes(command)) return readOnlyContainerCommand(arguments_, depth);
  if (command === "git") return readOnlyGit(arguments_);
  if (command === "systemctl") return readOnlySystemctl(arguments_);
  if (command === "service") return arguments_.at(-1) === "status";
  if (command === "journalctl") return !arguments_.some((argument) => /^(?:--rotate|--sync|--flush|--relinquish-var|--vacuum-|--update-catalog)/.test(argument));
  if (command === "find") return !arguments_.some((argument) => /^(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fls|-fprint0?|-fprintf)$/.test(argument));
  if (command === "rg") return !arguments_.some((argument) => argument === "--pre" || argument.startsWith("--pre="));
  if (["diff", "diff3"].includes(command)) return !arguments_.some((argument) => argument === "--output" || argument.startsWith("--output="));
  if (command === "sed") return !optionPresent(arguments_, "i", "--in-place");
  if (command === "sort") return !optionPresent(arguments_, "o", "--output");
  if (["jq", "yq"].includes(command)) return !optionPresent(arguments_, "i", "--in-place");
  if (command === "xxd") return !optionPresent(arguments_, "r", "--revert") && arguments_.filter((argument) => !argument.startsWith("-")).length <= 1;
  if (command === "date") return !optionPresent(arguments_, "s", "--set");
  if (command === "dmesg") return !optionPresent(arguments_, "c", "--clear");
  if (command === "hostname") return !arguments_.some((argument) => !argument.startsWith("-"));
  if (command === "hostnamectl") return arguments_.length === 0 || arguments_.includes("status");
  if (command === "mount") return !arguments_.some((argument) => !argument.startsWith("-"));
  if (command === "ip") return !arguments_.some((argument) => /^(?:add|append|change|delete|del|exec|flush|replace|set)$/i.test(argument));
  if (command === "curl") return readOnlyCurl(arguments_);
  if (command === "wget") {
    if (arguments_.some((argument) => /^(?:--post-data|--post-file|--method|--body-data|--body-file)(?:=|$)/.test(argument))) return false;
    return arguments_.includes("--spider") || arguments_.some((argument, argumentIndex) => argument === "-O" && arguments_[argumentIndex + 1] === "-");
  }
  if (command === "awk") return !arguments_.some((argument) => /@load|\b(?:system|close)\s*\(|(?:print|printf)[^;}\n]*>{1,2}|[|&]\s*getline|\bgetline\s*</.test(argument));
  if (command === "tar") {
    if (arguments_.some((argument) => /^(?:--checkpoint-action|--to-command|--use-compress-program)(?:=|$)/.test(argument))) return false;
    return optionPresent(arguments_, "t", "--list");
  }
  if (command === "unzip") return arguments_.includes("-l") || arguments_.includes("-Z");
  return false;
}

function isReadOnlyShell(source: string, depth = 0): boolean {
  const tokens = tokenizeShell(source, depth);
  if (!tokens?.length) return false;
  let words: string[] = [];
  const finish = () => {
    if (!words.length) return false;
    const result = isReadOnlySimple(words, depth);
    words = [];
    return result;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "separator") {
      if (!finish()) return false;
      continue;
    }
    if (token.kind === "redirect") {
      if (token.value.includes("<<") || token.value.includes("<>")) return false;
      if (/&(?:\d+|-)$/.test(token.value)) continue;
      const target = tokens[index + 1];
      if (!target || target.kind !== "word") return false;
      const output = token.value.includes(">");
      if (output && !SAFE_REDIRECT_TARGETS.has(target.value)) return false;
      index += 1;
      continue;
    }
    words.push(token.value);
  }
  return finish();
}

export function sshCommandRiskLevel(command: string): McpRiskLevel {
  return isReadOnlyShell(command) ? "low" : "high";
}
