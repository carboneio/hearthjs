INSERT INTO hearthjs."migration" ("filename", "up", "down") VALUES
(
  '1',
  '',
  'DROP TABLE "Test";'
),
(
  '2',
  '/* Description 2 */

ALTER TABLE "Test"
ADD COLUMN "isActive" INTEGER NOT NULL DEFAULT 1
;',
  '/* Description 2 */

ALTER TABLE "Test"
DROP COLUMN "isActive"
;'
)
;