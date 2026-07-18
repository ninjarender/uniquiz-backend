import { randomUUID } from 'node:crypto';

/**
 * In-memory PrismaService stand-in for e2e tests. Emulates exactly the
 * queries the services under test issue, including the users unique-email
 * constraint (P2002), select projection and ownership-scoped writes.
 */
export type StoredUser = { id: string; email: string; passwordHash: string };
export type StoredBank = {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
};
export type StoredQuestion = {
  id: string;
  bankId: string;
  text: string;
  imageUrl: string | null;
  referenceAnswer: string | null;
  createdAt: Date;
};
export type StoredAnswerSet = {
  id: string;
  questionId: string;
  options: string[];
  correctIndex: number;
  spareDistractor: string;
  explanation: string;
  status: string;
  selfCheckPassed: boolean;
  generatedAt: Date;
  reviewedAt: Date | null;
};

export class PrismaMock {
  private readonly usersByEmail = new Map<string, StoredUser>();
  private readonly banks: StoredBank[] = [];
  private readonly questions: StoredQuestion[] = [];
  private readonly answerSets = new Map<string, StoredAnswerSet>();
  private sequence = 0;

  /** Test seeding helper: a bank with N questions, M of them ready. */
  seedBank(
    userId: string,
    name: string,
    questionCount: number,
    readyCount: number,
  ): StoredBank {
    const bank: StoredBank = {
      id: randomUUID(),
      userId,
      name,
      createdAt: new Date(Date.now() + ++this.sequence * 1000),
      updatedAt: new Date(),
    };
    this.banks.push(bank);
    for (let i = 0; i < questionCount; i++) {
      const question: StoredQuestion = {
        id: randomUUID(),
        bankId: bank.id,
        text: `Question ${i + 1}`,
        imageUrl: null,
        referenceAnswer: null,
        createdAt: new Date(Date.now() + i * 1000),
      };
      this.questions.push(question);
      if (i < readyCount) {
        this.answerSets.set(question.id, {
          id: randomUUID(),
          questionId: question.id,
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 1,
          spareDistractor: 'E',
          explanation: 'because',
          status: 'accepted',
          selfCheckPassed: true,
          generatedAt: new Date(),
          reviewedAt: null,
        });
      }
    }
    return bank;
  }

  /** Introspection for cascade assertions. */
  counts(): { banks: number; questions: number; answerSets: number } {
    return {
      banks: this.banks.length,
      questions: this.questions.length,
      answerSets: this.answerSets.size,
    };
  }

  /** id of a registered user, for seeding. */
  userIdByEmail(email: string): string {
    const user = this.usersByEmail.get(email);
    if (!user) throw new Error(`no user ${email}`);
    return user.id;
  }

  $transaction = <T>(operations: Promise<T>[]): Promise<T[]> =>
    Promise.all(operations);

  answerSet = {
    deleteMany: ({
      where,
    }: {
      where: { question: { bankId: string; bank: { userId: string } } };
    }) => {
      const bank = this.banks.find(
        (b) =>
          b.id === where.question.bankId &&
          b.userId === where.question.bank.userId,
      );
      if (!bank) return Promise.resolve({ count: 0 });
      let count = 0;
      for (const question of this.questions) {
        if (question.bankId !== bank.id) continue;
        if (this.answerSets.delete(question.id)) count++;
      }
      return Promise.resolve({ count });
    },
  };

  user = {
    create: ({ data }: { data: { email: string; passwordHash: string } }) => {
      if (this.usersByEmail.has(data.email)) {
        return Promise.reject(
          Object.assign(new Error('Unique constraint failed on email'), {
            code: 'P2002',
          }),
        );
      }
      const user: StoredUser = {
        id: randomUUID(),
        email: data.email,
        passwordHash: data.passwordHash,
      };
      this.usersByEmail.set(data.email, user);
      return Promise.resolve({ id: user.id, email: user.email });
    },
    findUnique: ({
      where,
      select,
    }: {
      where: { email?: string; id?: string };
      select?: Partial<Record<keyof StoredUser, boolean>>;
    }) => {
      const user =
        where.email !== undefined
          ? this.usersByEmail.get(where.email)
          : [...this.usersByEmail.values()].find((u) => u.id === where.id);
      if (!user) return Promise.resolve(null);
      if (!select) return Promise.resolve({ ...user });
      const projected: Partial<StoredUser> = {};
      for (const key of Object.keys(select) as (keyof StoredUser)[]) {
        if (select[key]) projected[key] = user[key];
      }
      return Promise.resolve(projected);
    },
  };

  bank = {
    create: ({ data }: { data: { userId: string; name: string } }) => {
      const bank: StoredBank = {
        id: randomUUID(),
        userId: data.userId,
        name: data.name,
        createdAt: new Date(Date.now() + ++this.sequence * 1000),
        updatedAt: new Date(),
      };
      this.banks.push(bank);
      return Promise.resolve({ ...bank });
    },
    findFirst: ({ where }: { where: { id: string; userId: string } }) => {
      const bank = this.banks.find(
        (b) => b.id === where.id && b.userId === where.userId,
      );
      if (!bank) return Promise.resolve(null);
      const questions = this.questions
        .filter((q) => q.bankId === bank.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((q) => ({
          ...q,
          answerSet: this.answerSets.get(q.id)
            ? { ...this.answerSets.get(q.id)! }
            : null,
        }));
      return Promise.resolve({
        ...bank,
        _count: { questions: questions.length },
        questions,
      });
    },
    findMany: ({ where }: { where: { userId: string } }) => {
      const rows = this.banks
        .filter((bank) => bank.userId === where.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((bank) => ({
          ...bank,
          _count: {
            questions: this.questions.filter((q) => q.bankId === bank.id)
              .length,
          },
        }));
      return Promise.resolve(rows);
    },
    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; userId: string };
      data: { name: string };
    }) => {
      const bank = this.banks.find(
        (b) => b.id === where.id && b.userId === where.userId,
      );
      if (!bank) return Promise.resolve({ count: 0 });
      bank.name = data.name;
      bank.updatedAt = new Date();
      return Promise.resolve({ count: 1 });
    },
    deleteMany: ({ where }: { where: { id: string; userId: string } }) => {
      const index = this.banks.findIndex(
        (b) => b.id === where.id && b.userId === where.userId,
      );
      if (index === -1) return Promise.resolve({ count: 0 });
      this.banks.splice(index, 1);
      return Promise.resolve({ count: 1 });
    },
  };

  question = {
    create: ({
      data,
    }: {
      data: {
        bankId: string;
        text: string;
        imageUrl?: string;
        referenceAnswer?: string;
      };
    }) => {
      const question: StoredQuestion = {
        id: randomUUID(),
        bankId: data.bankId,
        text: data.text,
        imageUrl: data.imageUrl ?? null,
        referenceAnswer: data.referenceAnswer ?? null,
        createdAt: new Date(Date.now() + ++this.sequence * 1000),
      };
      this.questions.push(question);
      return Promise.resolve({ ...question });
    },
    deleteMany: ({
      where,
    }: {
      where: { bankId: string; bank: { userId: string } };
    }) => {
      const bank = this.banks.find(
        (b) => b.id === where.bankId && b.userId === where.bank.userId,
      );
      if (!bank) return Promise.resolve({ count: 0 });
      let count = 0;
      for (let i = this.questions.length - 1; i >= 0; i--) {
        if (this.questions[i].bankId === bank.id) {
          this.questions.splice(i, 1);
          count++;
        }
      }
      return Promise.resolve({ count });
    },
    count: ({
      where,
    }: {
      where: { bankId: string; answerSet: { status: { in: string[] } } };
    }) => {
      let count = 0;
      for (const question of this.questions) {
        if (question.bankId !== where.bankId) continue;
        const answerSet = this.answerSets.get(question.id);
        if (answerSet && where.answerSet.status.in.includes(answerSet.status))
          count++;
      }
      return Promise.resolve(count);
    },
    groupBy: ({
      where,
    }: {
      where: {
        bank: { userId: string };
        answerSet: { status: { in: string[] } };
      };
    }) => {
      const bankIds = new Set(
        this.banks
          .filter((bank) => bank.userId === where.bank.userId)
          .map((bank) => bank.id),
      );
      const counts = new Map<string, number>();
      for (const question of this.questions) {
        if (!bankIds.has(question.bankId)) continue;
        const answerSet = this.answerSets.get(question.id);
        if (!answerSet || !where.answerSet.status.in.includes(answerSet.status))
          continue;
        counts.set(question.bankId, (counts.get(question.bankId) ?? 0) + 1);
      }
      return Promise.resolve(
        [...counts.entries()].map(([bankId, count]) => ({
          bankId,
          _count: { _all: count },
        })),
      );
    },
  };
}
