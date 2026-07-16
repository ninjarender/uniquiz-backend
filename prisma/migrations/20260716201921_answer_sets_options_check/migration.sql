-- Exactly 4 options per answer set (data-model.md: options text[] CHECK).
-- Prisma cannot express array-length constraints, so it lives in raw SQL.
ALTER TABLE "answer_sets"
  ADD CONSTRAINT "answer_sets_options_length_check"
  CHECK (array_length("options", 1) = 4);
