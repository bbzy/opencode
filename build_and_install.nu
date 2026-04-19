#!/usr/bin/env nu

bun install

let old_dir = $env.PWD
try {
    cd packages/opencode
    let OPENCODE_VERSION = (open package.json | get version | str trim) + "-bbzy"
    with-env {OPENCODE_VERSION: $OPENCODE_VERSION, MODELS_DEV_API_JSON: "test/tool/fixtures/models-api.json"} {bun run build --single}
} finally {
    cd $old_dir
}

if $nu.os-info.name == 'windows' {
    cp packages/opencode/dist/opencode-windows-x64/bin/opencode.exe ~/.cargo/bin/
} else {
    let install_path = ($env.HOME + '/.opencode/bin/opencode')

    if ($install_path | path exists) {
        rm $install_path
    }

    ^./install -b packages/opencode/dist/opencode-darwin-arm64/bin/opencode
}

print "Installed opencode"
