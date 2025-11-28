// Test setup file
// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Mock fetch globally
global.fetch = jest.fn();

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
