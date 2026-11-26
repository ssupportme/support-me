import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { uploadAvatar, UploadError } from '../upload';

function makeFile(bytes = 1024, type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], 'avatar.png', { type });
}

const sign = {
  cloudName: 'test-cloud',
  apiKey: 'test-key',
  timestamp: 1700000000,
  signature: 'sig',
  folder: 'supportme/avatars',
  transformation: 'c_limit,w_512,h_512',
};

let fakeImageSize = { width: 100, height: 100 };
let fakeImageFails = false;

beforeEach(() => {
  fakeImageSize = { width: 100, height: 100 };
  fakeImageFails = false;
  // validateImageDimensions loads the file through the DOM Image API.
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    get width() {
      return fakeImageSize.width;
    }
    get height() {
      return fakeImageSize.height;
    }
    set src(_: string) {
      setTimeout(() => (fakeImageFails ? this.onerror?.() : this.onload?.()), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage as unknown as typeof Image);
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uploadAvatar (#364)', () => {
  it('sends the token as an Authorization header when requesting a signature', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/cloudinary-sign') {
        return new Response(JSON.stringify(sign), { status: 200 });
      }
      return new Response(JSON.stringify({ secure_url: 'https://cdn.test/avatar.png' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAvatar(makeFile(), 'jwt-token');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/cloudinary-sign',
      expect.objectContaining({ headers: { Authorization: 'Bearer jwt-token' } })
    );
  });

  it('rejects before requesting a signature when there is no token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sign), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(), null)).rejects.toThrow('Your session has expired');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the signing route 401 as an UploadError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 }))
    );

    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow(UploadError);
    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow('Authentication required');
  });

  it('rejects a non-image file before any network call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(1024, 'text/plain'), null)).rejects.toThrow(
      'Please choose a JPEG, PNG, WebP, or GIF image.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a file over 5 MB before any network call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(5 * 1024 * 1024 + 1), null)).rejects.toThrow(
      'Image is too large — please keep it under 5 MB.'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an image whose dimensions exceed 4096px', async () => {
    fakeImageSize = { width: 5000, height: 100 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await expect(uploadAvatar(makeFile(), null)).rejects.toThrow('Maximum allowed is 4096');
  });

  it('rejects an image whose dimensions cannot be read', async () => {
    fakeImageFails = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    await expect(uploadAvatar(makeFile(), null)).rejects.toThrow(
      'Could not read image dimensions. Please try a different image.'
    );
  });

  it('returns the secure URL on a full successful upload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/cloudinary-sign') {
        return new Response(JSON.stringify(sign), { status: 200 });
      }
      return new Response(JSON.stringify({ secure_url: 'https://cdn.test/avatar.png' }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(), 'jwt-token')).resolves.toBe('https://cdn.test/avatar.png');
  });

  it('reports a signing failure with no error body as a generic UploadError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow('Could not start the upload.');
  });

  it('reports an unreachable signing service as an UploadError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow('Could not reach the upload service.');
  });

  it('surfaces the Cloudinary error message when the upload itself fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/cloudinary-sign') {
        return new Response(JSON.stringify(sign), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Invalid image file' } }), {
        status: 400,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow('Invalid image file');
  });

  it('reports a missing secure URL after a successful upload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/cloudinary-sign') {
        return new Response(JSON.stringify(sign), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAvatar(makeFile(), 'jwt-token')).rejects.toThrow(
      'Upload succeeded but no image URL was returned.'
    );
  });
});
