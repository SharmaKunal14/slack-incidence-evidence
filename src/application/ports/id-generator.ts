import { randomUUID } from 'node:crypto';

export interface IdGenerator {
  generate(): string;
}

export const uuidGenerator: IdGenerator = {
  generate: randomUUID,
};
