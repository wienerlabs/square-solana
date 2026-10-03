export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;
}

export interface PaginatedResponse<T> {
  readonly success: boolean;
  readonly data: readonly T[];
  readonly pagination: {
    readonly total: number;
    readonly page: number;
    readonly limit: number;
    readonly total_pages: number;
  };
  readonly error: null;
}

export interface ApiError {
  readonly success: false;
  readonly data: null;
  readonly error: string;
  readonly details?: readonly string[];
}
