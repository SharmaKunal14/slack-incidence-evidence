import { prepareDeploymentConfiguration } from './deployment-configuration.js';

const paths = await prepareDeploymentConfiguration(process.cwd(), process.env);
process.stdout.write(
  `Prepared deployment configuration at ${paths.terraformVariablesPath}\n`,
);
