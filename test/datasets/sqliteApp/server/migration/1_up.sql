/* Create note */
CREATE TABLE "note" (
  "id" INTEGER PRIMARY KEY,
  "text" TEXT NOT NULL,
  "done" INTEGER NOT NULL DEFAULT 0,
  "meta" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (NOW())
);
