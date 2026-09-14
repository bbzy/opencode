def main [--full] {
  let root = ($env.FILE_PWD | path dirname)
  do {
    cd ($root | path join packages core)
    ^bun test test/refinement.test.ts test/session-runner.test.ts
    if $env.LAST_EXIT_CODE != 0 { error make {msg: "Core refinement tests failed"} }
    ^bun typecheck
    if $env.LAST_EXIT_CODE != 0 { error make {msg: "Core typecheck failed"} }
  }
  do {
    cd ($root | path join packages opencode)
    let args = if $full { [] } else { ["--test-name-pattern" "refine"] }
    ^bun test test/session/prompt.test.ts ...$args
    if $env.LAST_EXIT_CODE != 0 { error make {msg: "Legacy prompt tests failed"} }
    ^bun typecheck
    if $env.LAST_EXIT_CODE != 0 { error make {msg: "Opencode typecheck failed"} }
  }
}
