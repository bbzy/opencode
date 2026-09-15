import { createStore } from "solid-js/store"
import { createMemo, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import type { DirectoryGrant } from "@opencode-ai/sdk/v2"

export function DialogPermissions(props: { sessionID: string }) {
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const [store, setStore] = createStore({
    grants: [] as DirectoryGrant[],
    pending: [] as string[],
    loading: true,
    error: "",
  })
  dialog.setSize("large")
  const target = { sessionID: props.sessionID, workspace: project.workspace.current() }
  onMount(() => {
    void sdk.client.permission
      .directories(target, { throwOnError: true })
      .then((result) => setStore({ grants: result.data ?? [], loading: false }))
      .catch((error: unknown) => setStore({ error: errorMessage(error), loading: false }))
  })
  const options = createMemo(() =>
    store.grants
      .filter((grant) => !store.pending.includes(grant.id))
      .map((grant) => ({
        title: grant.pattern,
        value: grant.id,
        category:
          grant.scope === "session" ? "This session" : grant.scope === "project" ? "This project" : "Every project",
        description: "Revoke access",
        onSelect: () => {
          if (store.pending.includes(grant.id)) return
          setStore("pending", (ids) => [...ids, grant.id])
          void sdk.client.permission
            .revokeDirectory({ ...target, id: grant.id }, { throwOnError: true })
            .then(() => setStore("grants", (grants) => grants.filter((item) => item.id !== grant.id)))
            .then(() => setStore("pending", (ids) => ids.filter((id) => id !== grant.id)))
            .catch((error: unknown) => {
              toast.show({
                title: "Could not confirm directory access change",
                message: errorMessage(error),
                variant: "error",
              })
              // A lost response can follow a committed write. Reconcile only this row,
              // preserving other pending or successful revocations.
              return sdk.client.permission
                .directories(target, { throwOnError: true })
                .then((result) => {
                  const current = result.data?.find((item) => item.id === grant.id)
                  setStore("grants", (grants) => [
                    ...grants.filter((item) => item.id !== grant.id),
                    ...(current ? [current] : []),
                  ])
                  setStore("pending", (ids) => ids.filter((id) => id !== grant.id))
                })
                .catch(() =>
                  setStore("error", "Could not reload directory permissions. Reopen /permissions to check the result."),
                )
            })
        },
      })),
  )
  return (
    <DialogSelect
      title="Directory permissions"
      placeholder="Search saved directories…"
      options={options()}
      footer={store.error ? <text>{store.error}</text> : undefined}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text>
            {store.error ||
              (store.loading
                ? "Loading directory permissions…"
                : store.pending.length
                  ? "Saving changes…"
                  : "No saved directory approvals. Configured permissions still apply.")}
          </text>
        </box>
      }
    />
  )
}
