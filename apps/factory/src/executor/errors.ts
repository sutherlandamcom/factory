/** Shared error type: a failure with a machine-readable code for TaskResult. */
export class FactoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FactoryError";
  }
}
