export const log = {
    error: (message: string) => {
        console.warn(message);
    },
    info: (message: string) => {
        // disable info logging in production
        // console.info(message);
    },
    fatal: (message: string) => {
        console.error(message);
    },
};
