export class InvalidParametersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParametersError";
  }
}

export class SolveCaptchaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolveCaptchaError";
  }
}

export class OutOfCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfCreditsError";
  }
}

export class BannedPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BannedPromptError";
  }
}
