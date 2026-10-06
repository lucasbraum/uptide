import jwt from 'jsonwebtoken';
import { merge, pick } from 'lodash';
import moment from 'moment';
import { v4 } from 'uuid';

export const id = (): string => v4();
export const sign = (claims: object): string => jwt.sign(claims, 'synthetic-secret');
export const stamp = (): string => moment().format();
export const settings = (a: object, b: object): object => merge(pick(a, ['x']), b);
