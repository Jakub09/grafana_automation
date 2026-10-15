import { runCli } from './src/interfaces/cli/cli';

runCli(process.argv.slice(2))
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
