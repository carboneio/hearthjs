DROP TABLE "Test";

CREATE TABLE "Test2" (
  "id" SERIAL PRIMARY KEY,
  "label" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "Test2" ("label") VALUES (100);