import axios, {
  type AxiosError,
  type AxiosRequestConfig,
  type AxiosRequestHeaders,
  type AxiosResponse,
} from 'axios';

export const client = axios.create({ baseURL: 'https://api.example.com', timeout: 1000 });

// An interceptor typed with the public config type: 1.x passes InternalAxiosRequestConfig.
client.interceptors.request.use((config: AxiosRequestConfig) => {
  config.headers = { ...(config.headers as AxiosRequestHeaders), 'x-trace': '1' };
  return config;
});

// Headers as a plain record: 1.x wants RawAxiosRequestHeaders & AxiosHeaders.
export const headers: AxiosRequestHeaders = { Authorization: 'Bearer x' };

export async function fetchUser(id: string): Promise<AxiosResponse<{ id: string }>> {
  try {
    return await client.get(`/users/${id}`, {
      headers,
      paramsSerializer: (params) => String(params),
    });
  } catch (err) {
    const e = err as AxiosError;
    // error.status is a string in 0.27 and a number in 1.x.
    if (e.status === '404') throw new Error('not found');
    if (axios.isAxiosError(err) && err.config?.signal) console.log('aborted');
    throw err;
  }
}
