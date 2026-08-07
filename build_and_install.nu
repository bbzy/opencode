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

let os = if $nu.os-info.name == 'windows' {
    'windows'
} else if $nu.os-info.name == 'macos' {
    'darwin'
} else {
    'linux'
}

let arch = if $nu.os-info.arch == 'aarch64' {
    'arm64'
} else {
    'x64'
}

mut opencode_product_path = $'packages/opencode/dist/opencode-($os)-($arch)/bin/opencode'

if $os == 'windows' {
    $opencode_product_path += '.exe'
}

cp $opencode_product_path ~/.cargo/bin/

print "Installed opencode"
