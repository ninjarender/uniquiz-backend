-- CreateEnum
CREATE TYPE "AnswerSetStatus" AS ENUM ('generating', 'self_check', 'in_review', 'accepted', 'edited', 'regenerating');

-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('solo', 'multiplayer');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "image_url" TEXT,
    "reference_answer" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answer_sets" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "options" TEXT[],
    "correct_index" SMALLINT NOT NULL,
    "spare_distractor" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" "AnswerSetStatus" NOT NULL,
    "self_check_passed" BOOLEAN NOT NULL,
    "generated_at" TIMESTAMPTZ NOT NULL,
    "reviewed_at" TIMESTAMPTZ,

    CONSTRAINT "answer_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_results" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bank_id" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "question_count" INTEGER NOT NULL,
    "finished_at" TIMESTAMPTZ NOT NULL,
    "leaderboard" JSONB NOT NULL,

    CONSTRAINT "game_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "answer_sets_question_id_key" ON "answer_sets"("question_id");

-- AddForeignKey
ALTER TABLE "banks" ADD CONSTRAINT "banks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_sets" ADD CONSTRAINT "answer_sets_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
