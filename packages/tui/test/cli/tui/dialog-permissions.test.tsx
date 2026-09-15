/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, eventSource, json } from "../../fixture/tui-sdk"
import { SDKProvider } from "../../../src/context/sdk"
import { ProjectProvider } from "../../../src/context/project"
import { DialogPermissions } from "../../../src/component/dialog-permissions"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"

async function wait(fn: () => boolean) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for directory permissions")
    await Bun.sleep(10)
  }
}

test("directory revoke is immediate and a failed save preserves a successful independent revoke", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const first = Promise.withResolvers<Response>()
  const second = Promise.withResolvers<Response>()
  const calls: string[] = []
  const api = createFetch((url) => {
    if (url.pathname === "/permission/directory")
      return json([
        { id: "one", scope: "session", owner: "ses_test", pattern: "/first/*" },
        { id: "two", scope: "session", owner: "ses_test", pattern: "/second/*" },
      ])
    if (url.pathname.startsWith("/permission/directory/")) {
      expect(url.searchParams.get("sessionID")).toBe("ses_test")
      calls.push(url.pathname)
      return url.pathname.endsWith("/one") ? first.promise : second.promise
    }
    return undefined
  })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <SDKProvider url="http://localhost:4096" directory={tmp.path} fetch={api.fetch} events={eventSource()}>
              <ProjectProvider>
                <KVProvider>
                  <ThemeProvider mode="dark">
                    <ToastProvider>
                      <DialogProvider>
                        <DialogPermissions sessionID="ses_test" />
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </KVProvider>
              </ProjectProvider>
            </SDKProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 100, height: 30 })
  try {
    await wait(() => app.captureCharFrame().includes("/first/*"))
    app.mockInput.pressEnter()
    await wait(() => calls.length === 1)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("/first/*")
    expect(app.captureCharFrame()).toContain("/second/*")
    app.mockInput.pressEnter()
    await wait(() => calls.length === 2)
    second.resolve(json(true))
    first.resolve(json({ message: "save failed" }, { status: 500 }))
    await wait(() => app.captureCharFrame().includes("/first/*"))
    expect(app.captureCharFrame()).not.toContain("/second/*")
  } finally {
    first.resolve(json(true))
    second.resolve(json(true))
    app.renderer.destroy()
  }
})
