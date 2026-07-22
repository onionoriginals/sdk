import { describe, test, expect } from 'bun:test';
import { isLikelyDeployed } from '../deploy-env';

describe('isLikelyDeployed', () => {
  test('false for a bare/local env', () => {
    expect(isLikelyDeployed({})).toBe(false);
    expect(isLikelyDeployed({ NODE_ENV: 'development' })).toBe(false);
    expect(isLikelyDeployed({ NODE_ENV: 'test' })).toBe(false);
  });

  test('true for Railway env markers', () => {
    expect(isLikelyDeployed({ RAILWAY_ENVIRONMENT: 'production' })).toBe(true);
    expect(isLikelyDeployed({ RAILWAY_PROJECT_ID: 'abc' })).toBe(true);
    expect(isLikelyDeployed({ RAILWAY_SERVICE_ID: 'svc' })).toBe(true);
  });

  test('true for a generic production NODE_ENV', () => {
    expect(isLikelyDeployed({ NODE_ENV: 'production' })).toBe(true);
  });
});
