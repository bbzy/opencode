# Directory permissions in the terminal

When a tool requests access outside the project, choose **Allow once** or **Remember…**.
Remember offers three scopes:

- **This session**: only the session that owns the request, including after reopening it.
- **This project**: all sessions in this project.
- **Every project**: all projects using this OpenCode server's database.

The displayed directory patterns are saved immediately. Matching pending requests on the same server are rechecked, so work can continue without restarting the server or rebuilding the project instance. Future directory checks read the saved grants directly. Grants do not override an explicit configured denial or grant separate edit/shell permissions.

Run **/permissions** in a session to see the directory grants that apply to it, grouped by scope. Select an entry to revoke it. Revocation applies to subsequent permission checks; it does not cancel a tool already authorized to run. A failed revoke restores that entry and shows an error.

This screen manages directory approvals created with **Remember…**. Rules in configuration files, older process-local “Allow always” approvals, and other tool permissions are separate. Removing a saved grant does not override an allow rule in configuration. Session grants apply to the owning session, not automatically to its child sessions.

Project and global grants are stored in the OpenCode database alongside session grants. Independent server processes sharing a database see changes on their next permission check; already pending requests in another process are not notified.
