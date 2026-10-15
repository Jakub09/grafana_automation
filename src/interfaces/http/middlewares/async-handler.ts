import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 nie przekazuje odrzuconych Promise do errorHandlera - robimy to ręcznie */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
        fn(req, res, next).catch(next);
    };
