import { createChildLogger } from '../../shared/utils/index';

const logger = createChildLogger('github-service');

export interface GitHubConfig {
  token: string;
  defaultOwner?: string;
  defaultRepo?: string;
}

export interface SearchResult {
  path: string;
  repository: string;
  url: string;
  snippet: string;
  score: number;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
  url: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export class GitHubService {
  private config: GitHubConfig;
  private baseUrl = 'https://api.github.com';

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Jarvis-Voice-Assistant',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  async searchCode(
    query: string,
    options: { repo?: string; language?: string; limit?: number } = {}
  ): Promise<SearchResult[]> {
    const { repo, language, limit = 10 } = options;

    let searchQuery = query;
    if (repo) {
      searchQuery += ` repo:${repo}`;
    } else if (this.config.defaultOwner && this.config.defaultRepo) {
      searchQuery += ` repo:${this.config.defaultOwner}/${this.config.defaultRepo}`;
    }
    if (language) {
      searchQuery += ` language:${language}`;
    }

    logger.debug({ query: searchQuery }, 'Searching GitHub code');

    const result = await this.request<{
      items: Array<{
        path: string;
        repository: { full_name: string };
        html_url: string;
        text_matches?: Array<{ fragment: string }>;
        score: number;
      }>;
    }>(`/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${limit}`, {
      headers: {
        Accept: 'application/vnd.github.text-match+json',
      },
    });

    return result.items.map((item) => ({
      path: item.path,
      repository: item.repository.full_name,
      url: item.html_url,
      snippet: item.text_matches?.[0]?.fragment || '',
      score: item.score,
    }));
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string
  ): Promise<FileContent> {
    logger.debug({ owner, repo, path }, 'Fetching file content');

    const result = await this.request<{
      path: string;
      content: string;
      sha: string;
      html_url: string;
      encoding: string;
    }>(`/repos/${owner}/${repo}/contents/${path}`);

    let content = result.content;
    if (result.encoding === 'base64') {
      content = Buffer.from(result.content, 'base64').toString('utf-8');
    }

    return {
      path: result.path,
      content,
      sha: result.sha,
      url: result.html_url,
    };
  }

  async searchIssues(
    query: string,
    options: { repo?: string; state?: 'open' | 'closed' | 'all'; limit?: number } = {}
  ): Promise<Issue[]> {
    const { repo, state = 'all', limit = 10 } = options;

    let searchQuery = query;
    if (repo) {
      searchQuery += ` repo:${repo}`;
    }
    searchQuery += ` is:issue state:${state}`;

    logger.debug({ query: searchQuery }, 'Searching GitHub issues');

    const result = await this.request<{
      items: Array<{
        number: number;
        title: string;
        body: string;
        state: string;
        html_url: string;
        labels: Array<{ name: string }>;
        created_at: string;
        updated_at: string;
      }>;
    }>(`/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${limit}`);

    return result.items.map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body || '',
      state: item.state,
      url: item.html_url,
      labels: item.labels.map((l) => l.name),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    }));
  }

  async getReadme(owner: string, repo: string): Promise<string> {
    logger.debug({ owner, repo }, 'Fetching README');

    const result = await this.request<{
      content: string;
      encoding: string;
    }>(`/repos/${owner}/${repo}/readme`);

    if (result.encoding === 'base64') {
      return Buffer.from(result.content, 'base64').toString('utf-8');
    }

    return result.content;
  }

  async listRepoContents(
    owner: string,
    repo: string,
    path = ''
  ): Promise<Array<{ name: string; path: string; type: 'file' | 'dir' }>> {
    logger.debug({ owner, repo, path }, 'Listing repository contents');

    const result = await this.request<
      Array<{
        name: string;
        path: string;
        type: string;
      }>
    >(`/repos/${owner}/${repo}/contents/${path}`);

    return result.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type as 'file' | 'dir',
    }));
  }
}

// Tool definitions for LLM integration
export const githubTools = [
  {
    name: 'search_github_code',
    description: 'Search for code in GitHub repositories',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query for code',
        },
        repo: {
          type: 'string',
          description: 'Optional: specific repository (owner/repo format)',
        },
        language: {
          type: 'string',
          description: 'Optional: filter by programming language',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_github_file',
    description: 'Get the contents of a file from a GitHub repository',
    parameters: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Repository owner',
        },
        repo: {
          type: 'string',
          description: 'Repository name',
        },
        path: {
          type: 'string',
          description: 'Path to the file',
        },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'search_github_issues',
    description: 'Search for issues in GitHub repositories',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query for issues',
        },
        repo: {
          type: 'string',
          description: 'Optional: specific repository (owner/repo format)',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by issue state',
        },
      },
      required: ['query'],
    },
  },
];
