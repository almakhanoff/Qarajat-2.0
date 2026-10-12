import { useEffect, useState } from 'react';
import { getAttachment } from './db';

export function useAttachmentUrl(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    void getAttachment(id).then((a) => {
      if (revoked || !a) return;
      created = URL.createObjectURL(a.blob);
      setUrl(created);
    });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id]);
  return url;
}
