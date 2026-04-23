import type { LLMClassifier, ClassifierInput, ClassifierOutput } from "./types"

export class MockClassifier implements LLMClassifier {
  private readonly output: ClassifierOutput
  constructor(output: ClassifierOutput) { this.output = output }
  async classify(_input: ClassifierInput): Promise<ClassifierOutput> { return this.output }
}
