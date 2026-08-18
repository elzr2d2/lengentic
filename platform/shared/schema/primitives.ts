import { z } from 'zod';

export const MAX_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 200;

export const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);
export const NameSchema = z.string().min(1).max(MAX_NAME_LENGTH);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const MetadataSchema = z.record(z.string(), z.unknown());

export type Metadata = z.infer<typeof MetadataSchema>;
