INSERT INTO "note" ("text", "done", "meta")
VALUES ({{ data.body.text }}, {{ data.body.done }}, {{ data.body.meta }})
RETURNING "id", "text";
