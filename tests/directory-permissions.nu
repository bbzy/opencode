def main [] {
  let root = ($env.FILE_PWD | path dirname)
  for package in [core opencode tui] {
    do {
      cd ($root | path join packages $package)
      let files = match $package {
        core => [test/permission.test.ts]
        opencode => [test/permission/next.test.ts]
        tui => [test/cli/tui/dialog-permissions.test.tsx]
      }
      ^bun test ...$files
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"($package) permission tests failed"} }
      if $package == opencode {
        ^bun test test/server/httpapi-instance.test.ts --test-name-pattern "directory grants"
        if $env.LAST_EXIT_CODE != 0 { error make {msg: "Directory permission HTTP test failed"} }
      }
      ^bun typecheck
      if $env.LAST_EXIT_CODE != 0 { error make {msg: $"($package) typecheck failed"} }
    }
  }
}
