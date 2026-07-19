import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, Type } from '@google/genai';

/**
 * Thin wrapper over the Gemini API: structured-JSON calls only, no business
 * logic. Output validation lives in the processor - this service returns
 * whatever JSON the model produced (or throws on API/parse failure).
 */
@Injectable()
export class GeminiService {
  private readonly client: GoogleGenAI;
  private readonly generationModel: string;
  private readonly selfCheckModel: string;

  constructor(config: ConfigService) {
    this.client = new GoogleGenAI({
      apiKey: config.get<string>('GEMINI_API_KEY'),
    });
    this.generationModel = config.get<string>(
      'GEMINI_GENERATION_MODEL',
      'gemini-2.5-flash',
    );
    this.selfCheckModel = config.get<string>(
      'GEMINI_SELF_CHECK_MODEL',
      'gemini-2.5-flash-lite',
    );
  }

  /** Full set for a question without a reference answer. */
  async generateFullSet(questionText: string): Promise<unknown> {
    return this.structuredCall(
      this.generationModel,
      [
        'Ти — досвідчений методист, який складає тестові запитання українською мовою.',
        `Запитання: "${questionText}"`,
        'Створи 4 варіанти відповіді: один правильний і три правдоподібні дистрактори.',
        'Додай запасний дистрактор (він замінить правильний варіант у "пастковій" версії запитання) і коротке пояснення, чому правильна відповідь саме така.',
      ].join('\n'),
      {
        type: Type.OBJECT,
        properties: {
          options: {
            type: Type.ARRAY,
            minItems: '4',
            maxItems: '4',
            items: { type: Type.STRING },
          },
          correctIndex: { type: Type.INTEGER },
          spareDistractor: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['options', 'correctIndex', 'spareDistractor', 'explanation'],
      },
    );
  }

  /** Distractors only - the host already provided the reference answer. */
  async generateDistractors(
    questionText: string,
    referenceAnswer: string,
  ): Promise<unknown> {
    return this.structuredCall(
      this.generationModel,
      [
        'Ти — досвідчений методист, який складає тестові запитання українською мовою.',
        `Запитання: "${questionText}"`,
        `Правильна відповідь: "${referenceAnswer}"`,
        'Створи три правдоподібні, але хибні дистрактори до цієї відповіді.',
        'Додай запасний дистрактор (він замінить правильний варіант у "пастковій" версії запитання) і коротке пояснення, чому правильна відповідь саме така.',
      ].join('\n'),
      {
        type: Type.OBJECT,
        properties: {
          distractors: {
            type: Type.ARRAY,
            minItems: '3',
            maxItems: '3',
            items: { type: Type.STRING },
          },
          spareDistractor: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['distractors', 'spareDistractor', 'explanation'],
      },
    );
  }

  /**
   * Self-check by a second model: pick the correct option without any hint.
   * Returns the model's raw JSON ({ correctIndex }).
   */
  async pickCorrectOption(
    questionText: string,
    options: string[],
  ): Promise<unknown> {
    return this.structuredCall(
      this.selfCheckModel,
      [
        'Обери правильну відповідь на тестове запитання.',
        `Запитання: "${questionText}"`,
        ...options.map((option, index) => `${index}: ${option}`),
        'Поверни індекс правильного варіанта.',
      ].join('\n'),
      {
        type: Type.OBJECT,
        properties: { correctIndex: { type: Type.INTEGER } },
        required: ['correctIndex'],
      },
    );
  }

  private async structuredCall(
    model: string,
    prompt: string,
    responseSchema: object,
  ): Promise<unknown> {
    const response = await this.client.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema },
    });
    return JSON.parse(response.text ?? '') as unknown;
  }
}
