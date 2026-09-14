# hearthjs

## Code

Every change is held to four properties, and they apply at every scope at once — an expression, a
function, a file, and the whole path from the UI to the database. This is how the first version is
written, not a later polish pass.

- **Minimal.** The least code that fully solves the problem, and no more. Prefer deleting to adding;
  reuse what exists before writing a variant; fold duplicated logic into one owner. Between two
  changes that reach the same end, the one that touches fewer lines and adds fewer concepts wins. A
  dead branch, an unused parameter, a second helper that does what one already does, a layer that
  only forwards — removed, not left. The same holds end to end: don't add a field, an endpoint or a
  round trip the feature doesn't need.
- **Elegant.** The code reads like the code around it and states its intent directly: the shape of
  the solution matches the shape of the problem, names say what a thing is, and the control flow is
  the plain one. Delegate to the platform — the URL parser, the DB, the framework — instead of
  re-implementing it, and make a check run the *same* primitive as the thing it guards so the two
  cannot drift (a redirect allow-list resolves with the same parser the browser follows; a query and
  its validation share one source of truth). No cleverness a reader has to decode.
- **Ultra performant.** No wasted work: nothing parsed, fetched, allocated or queried twice when once
  will do; no N+1 query where a join or a batch does it in one; no O(n²) where a map is O(n); a value
  computed once and reused. Push work to where it is cheapest — the DB, an index, build time, a cache
  with a stated TTL — and do it lazily when it may not be needed at all.
- **Secure.** Deny by default, and match against an exact allow-list, never a substring or a denylist
  (an origin is compared by whole host equality, not `.includes`). Validate the exact value you will
  use, not a copy of it: a decode, a normalisation or a second lookup between the check and the sink
  is how a payload walks past the check (validate the string you follow; resolve with the same parser
  that will follow it). Authorisation is derived server-side from the session, never from the request,
  and every read and write is scoped by the caller's account and role. Trust no input — validate type,
  shape and length at the edge, and bind parameters, never build SQL or markup by concatenation. Fail
  closed when config or a lookup is missing. Leak nothing: "not allowed" and "not found" answer the
  same, an internal error never reaches the client, and a masked secret keeps only its last four.
  Security-relevant logic is proven with the attack vectors in a test, on every tier that enforces it.
