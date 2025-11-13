import { describe, test, expect, mock } from "bun:test";
import {
  TurnkeySessionExpiredError,
  isTokenExpiredError,
  withTokenExpiration,
} from "../turnkey-error-handler";

describe("turnkey-error-handler", () => {
  describe("TurnkeySessionExpiredError", () => {
    test("creates error with default message", () => {
      const error = new TurnkeySessionExpiredError();

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("TurnkeySessionExpiredError");
      expect(error.message).toBe("Turnkey session has expired");
    });

    test("creates error with custom message", () => {
      const customMessage = "Your session has expired, please log in again";
      const error = new TurnkeySessionExpiredError(customMessage);

      expect(error.message).toBe(customMessage);
      expect(error.name).toBe("TurnkeySessionExpiredError");
    });

    test("is instanceof Error", () => {
      const error = new TurnkeySessionExpiredError();

      expect(error instanceof Error).toBe(true);
      expect(error instanceof TurnkeySessionExpiredError).toBe(true);
    });
  });

  describe("isTokenExpiredError", () => {
    test("returns true for 'unauthorized' error", () => {
      const error = new Error("Request unauthorized");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for 'invalid session' error", () => {
      const error = new Error("Invalid session token provided");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for 'session expired' error", () => {
      const error = new Error("Your session expired, please log in");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for 'token expired' error", () => {
      const error = new Error("Access token expired");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for 'invalid token' error", () => {
      const error = new Error("Invalid token format");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for 'authentication failed' error", () => {
      const error = new Error("Authentication failed: credentials rejected");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for '401' error", () => {
      const error = new Error("Request failed with status 401");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for '403' error", () => {
      const error = new Error("HTTP 403 Forbidden");
      expect(isTokenExpiredError(error)).toBe(true);
    });

    test("returns true for case-insensitive matches", () => {
      const error1 = new Error("UNAUTHORIZED");
      const error2 = new Error("Session EXPIRED");
      const error3 = new Error("Invalid TOKEN");

      expect(isTokenExpiredError(error1)).toBe(true);
      expect(isTokenExpiredError(error2)).toBe(true);
      expect(isTokenExpiredError(error3)).toBe(true);
    });

    test("returns true for string errors", () => {
      expect(isTokenExpiredError("unauthorized access")).toBe(true);
      expect(isTokenExpiredError("Session expired")).toBe(true);
      expect(isTokenExpiredError("401 error")).toBe(true);
    });

    test("returns false for unrelated errors", () => {
      const error = new Error("Network request failed");
      expect(isTokenExpiredError(error)).toBe(false);
    });

    test("returns false for generic errors", () => {
      const error = new Error("Something went wrong");
      expect(isTokenExpiredError(error)).toBe(false);
    });

    test("returns false for null", () => {
      expect(isTokenExpiredError(null)).toBe(false);
    });

    test("returns false for undefined", () => {
      expect(isTokenExpiredError(undefined)).toBe(false);
    });

    test("returns false for empty string", () => {
      expect(isTokenExpiredError("")).toBe(false);
    });

    test("returns false for non-auth related errors", () => {
      const error = new Error("Database connection failed");
      expect(isTokenExpiredError(error)).toBe(false);
    });

    test("handles errors with multiple matching patterns", () => {
      const error = new Error("401 unauthorized: token expired");
      expect(isTokenExpiredError(error)).toBe(true);
    });
  });

  describe("withTokenExpiration", () => {
    test("returns result on successful operation", async () => {
      const operation = mock(async () => {
        return "success";
      });

      const result = await withTokenExpiration(operation);

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test("returns complex result on successful operation", async () => {
      const expectedResult = { id: "123", data: { value: 42 } };
      const operation = mock(async () => expectedResult);

      const result = await withTokenExpiration(operation);

      expect(result).toEqual(expectedResult);
    });

    test("throws TurnkeySessionExpiredError on token expiration", async () => {
      const operation = mock(async () => {
        throw new Error("unauthorized");
      });

      await expect(withTokenExpiration(operation)).rejects.toThrow(
        TurnkeySessionExpiredError
      );
    });

    test("calls onExpired callback on token expiration", async () => {
      const onExpired = mock(() => {});
      const operation = mock(async () => {
        throw new Error("Session expired");
      });

      await expect(withTokenExpiration(operation, onExpired)).rejects.toThrow();

      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    test("does not call onExpired on non-expiration errors", async () => {
      const onExpired = mock(() => {});
      const operation = mock(async () => {
        throw new Error("Network error");
      });

      await expect(withTokenExpiration(operation, onExpired)).rejects.toThrow(
        "Network error"
      );

      expect(onExpired).toHaveBeenCalledTimes(0);
    });

    test("re-throws non-expiration errors unchanged", async () => {
      const customError = new Error("Custom error message");
      const operation = mock(async () => {
        throw customError;
      });

      await expect(withTokenExpiration(operation)).rejects.toThrow(customError);
    });

    test("works without onExpired callback", async () => {
      const operation = mock(async () => {
        throw new Error("401 unauthorized");
      });

      await expect(withTokenExpiration(operation)).rejects.toThrow(
        TurnkeySessionExpiredError
      );
    });

    test("handles operation that throws string", async () => {
      const operation = mock(async () => {
        throw "unauthorized access";
      });

      await expect(withTokenExpiration(operation)).rejects.toThrow(
        TurnkeySessionExpiredError
      );
    });

    test("handles operation with multiple calls", async () => {
      let callCount = 0;
      const operation = mock(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("unauthorized");
        }
        return "success";
      });

      const onExpired = mock(() => {});

      // First call should throw
      await expect(withTokenExpiration(operation, onExpired)).rejects.toThrow(
        TurnkeySessionExpiredError
      );
      expect(onExpired).toHaveBeenCalledTimes(1);

      // Second call should succeed
      const result = await withTokenExpiration(operation, onExpired);
      expect(result).toBe("success");
      expect(onExpired).toHaveBeenCalledTimes(1); // Still only called once
    });

    test("handles async onExpired callback", async () => {
      const onExpired = mock(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      const operation = mock(async () => {
        throw new Error("token expired");
      });

      await expect(withTokenExpiration(operation, onExpired)).rejects.toThrow(
        TurnkeySessionExpiredError
      );

      expect(onExpired).toHaveBeenCalledTimes(1);
    });

    test("preserves operation context", async () => {
      const context = { value: 42 };
      const operation = mock(async function(this: typeof context) {
        return this.value;
      });

      const result = await withTokenExpiration(operation.bind(context));

      expect(result).toBe(42);
    });

    test("handles operation that returns Promise.resolve", async () => {
      const operation = mock(() => Promise.resolve("immediate"));

      const result = await withTokenExpiration(operation);

      expect(result).toBe("immediate");
    });

    test("handles operation that returns Promise.reject", async () => {
      const operation = mock(() => Promise.reject(new Error("unauthorized")));

      await expect(withTokenExpiration(operation)).rejects.toThrow(
        TurnkeySessionExpiredError
      );
    });
  });
});
