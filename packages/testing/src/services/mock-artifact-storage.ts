export class MockArtifactStorage {
  private readonly artifacts = new Map<string, string>();

  store(id: string, content: string): void {
    this.artifacts.set(id, content);
  }

  retrieve(id: string): string | undefined {
    return this.artifacts.get(id);
  }

  listIds(): string[] {
    return Array.from(this.artifacts.keys());
  }

  has(id: string): boolean {
    return this.artifacts.has(id);
  }

  reset(): void {
    this.artifacts.clear();
  }
}
