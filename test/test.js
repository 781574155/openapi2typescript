const assert = require('assert');
const path = require('path');
const fs = require('fs');

const openAPI = require('../dist/index');

const gen = async () => {
  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-empty.json`,
    serversPath: './servers/empty',
  });

  await openAPI.generateService({
    schemaPath: `${__dirname}/test-allof-api.json`,
    serversPath: './servers-allof',
  });

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers',
  });

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/react-query',
    reactQuery: true,
  });

  const reactQueryControllerStr = fs.readFileSync(
    path.join(__dirname, 'servers/react-query/api/psp.ts'),
    'utf8',
  );
  assert(reactQueryControllerStr.indexOf("from '@tanstack/react-query'") > 0);
  assert(reactQueryControllerStr.indexOf('export const getAdminListQueryKey') > 0);
  assert(reactQueryControllerStr.indexOf('export function useAdminListQuery') > 0);
  assert(reactQueryControllerStr.indexOf('ReactQueryData<typeof adminList>') > 0);
  assert(reactQueryControllerStr.indexOf('useMutation') < 0);
  assert(reactQueryControllerStr.indexOf('ReactMutationHookOptions') < 0);
  assert(reactQueryControllerStr.indexOf('export function useAdminCreateMutation') < 0);

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/react-query-with-mutation',
    reactQuery: {
      mutation: true,
    },
  });

  const reactQueryWithMutationControllerStr = fs.readFileSync(
    path.join(__dirname, 'servers/react-query-with-mutation/api/psp.ts'),
    'utf8',
  );
  assert(reactQueryWithMutationControllerStr.indexOf('export function useAdminListQuery') > 0);
  assert(
    reactQueryWithMutationControllerStr.indexOf('export function useAdminCreateMutation') > 0,
  );
  assert(reactQueryWithMutationControllerStr.indexOf('ReactQueryData<typeof adminCreate>') > 0);
  assert(reactQueryWithMutationControllerStr.indexOf('return useMutation<') > 0);
  assert(reactQueryWithMutationControllerStr.indexOf('LogoutMutationVariables') > 0);

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/react-query-without-mutation',
    reactQuery: {
      mutation: false,
    },
  });

  const reactQueryWithoutMutationControllerStr = fs.readFileSync(
    path.join(__dirname, 'servers/react-query-without-mutation/api/psp.ts'),
    'utf8',
  );
  assert(reactQueryWithoutMutationControllerStr.indexOf('export function useAdminListQuery') > 0);
  assert(reactQueryWithoutMutationControllerStr.indexOf('useMutation') < 0);
  assert(reactQueryWithoutMutationControllerStr.indexOf('ReactMutationHookOptions') < 0);
  assert(
    reactQueryWithoutMutationControllerStr.indexOf('export function useAdminCreateMutation') < 0,
  );

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/react-query-get-only',
    reactQuery: true,
    hook: {
      afterOpenApiDataInited: (openAPIData) => {
        Object.keys(openAPIData.paths || {}).forEach((apiPath) => {
          const pathItem = openAPIData.paths[apiPath];
          if (!pathItem.get) {
            delete openAPIData.paths[apiPath];
            return;
          }
          ['put', 'post', 'delete', 'patch'].forEach((method) => {
            delete pathItem[method];
          });
        });
        return openAPIData;
      },
    },
  });

  const reactQueryGetOnlyControllerStr = fs.readFileSync(
    path.join(__dirname, 'servers/react-query-get-only/api/psp.ts'),
    'utf8',
  );
  assert(reactQueryGetOnlyControllerStr.indexOf('useQuery') > 0);
  assert(reactQueryGetOnlyControllerStr.indexOf('UseQueryOptions') > 0);
  assert(reactQueryGetOnlyControllerStr.indexOf('ReactQueryHookOptions') > 0);
  assert(reactQueryGetOnlyControllerStr.indexOf('useMutation') < 0);
  assert(reactQueryGetOnlyControllerStr.indexOf('UseMutationOptions') < 0);
  assert(reactQueryGetOnlyControllerStr.indexOf('ReactMutationHookOptions') < 0);

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/react-query-mutation-only',
    reactQuery: {
      mutation: true,
    },
    hook: {
      afterOpenApiDataInited: (openAPIData) => {
        Object.keys(openAPIData.paths || {}).forEach((apiPath) => {
          const pathItem = openAPIData.paths[apiPath];
          ['get'].forEach((method) => {
            delete pathItem[method];
          });
          const hasOperation = ['put', 'post', 'delete', 'patch'].some((method) => pathItem[method]);
          if (!hasOperation) {
            delete openAPIData.paths[apiPath];
          }
        });
        return openAPIData;
      },
    },
  });

  const reactQueryMutationOnlyControllerStr = fs.readFileSync(
    path.join(__dirname, 'servers/react-query-mutation-only/api/psp.ts'),
    'utf8',
  );
  assert(reactQueryMutationOnlyControllerStr.indexOf('useMutation') > 0);
  assert(reactQueryMutationOnlyControllerStr.indexOf('UseMutationOptions') > 0);
  assert(reactQueryMutationOnlyControllerStr.indexOf('ReactMutationHookOptions') > 0);
  assert(reactQueryMutationOnlyControllerStr.indexOf('useQuery') < 0);
  assert(reactQueryMutationOnlyControllerStr.indexOf('UseQueryOptions') < 0);
  assert(reactQueryMutationOnlyControllerStr.indexOf('ReactQueryHookOptions') < 0);

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-schema-contain-blank-symbol.json`,
    serversPath: './servers/blank-symbol-servers',
  });

  await openAPI.generateService({
    requestLibPath: "import request  from '@/request';",
    schemaPath: `${__dirname}/example-files/swagger-custom-hook.json`,
    serversPath: './servers/custom',
    declareType: 'interface',
    hook: {
      // 自定义类名
      customClassName: (tagName) => {
        return /[A-Z].+/.exec(tagName);
      },
      // 自定义函数名
      customFunctionName: (data) => {
        let funName = data.operationId ? data.operationId : '';
        const suffix = 'Using';
        if (funName.indexOf(suffix) != -1) {
          funName = funName.substring(0, funName.lastIndexOf(suffix));
        }
        return funName;
      },
      // 自定义类型名
      customTypeName: (data) => {
        const { operationId } = data;
        const funName = operationId ? operationId[0].toUpperCase() + operationId.substring(1) : '';
        const tag = data?.tags?.[0];

        return `${tag ? tag : ''}${funName}`;
      },
    },
  });

  // 支持null类型作为默认值
  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/support-null',
    nullable: true,
  });

  // 正常命名文件和请求函数
  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/name/normal',
    isCamelCase: false,
  });

  // 小驼峰命名文件和请求函数
  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-get-method-params-convert-obj.json`,
    serversPath: './servers/name/camel-case',
    isCamelCase: true,
  });

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/swagger-file-convert.json`,
    serversPath: './file-servers',
  });

  // check 文件生成
  const fileControllerStr = fs.readFileSync(
    path.join(__dirname, 'file-servers/api/fileController.ts'),
    'utf8',
  );
  assert(fileControllerStr.indexOf('!(item instanceof File)') > 0);
  assert(fileControllerStr.indexOf('Content-Type') < 0);
  // await openAPI.generateService({
  //   // requestLibPath: "import request  from '@/request';",
  //   schemaPath: `http://82.157.33.9/swagger/swagger.json`,
  //   serversPath: './servers',
  // });
  // await openAPI.generateService({
  //   schemaPath: 'https://gw.alipayobjects.com/os/antfincdn/CA1dOm%2631B/openapi.json',
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: 'http://petstore.swagger.io/v2/swagger.json',
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: 'https://gw.alipayobjects.com/os/antfincdn/LyDMjDyIhK/1611471979478-opa.json',
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: 'https://gw.alipayobjects.com/os/antfincdn/Zd7dLTHUjE/ant-design-pro.json',
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: `${__dirname}/morse-api.json`,
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: `${__dirname}/oc-swagger.json`,
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });
  // await openAPI.generateService({
  //   schemaPath: `${__dirname}/java-api.json`,
  //   serversPath: './servers',
  //   mockFolder: './mocks',
  // });

  await openAPI.generateService({
    schemaPath: `${__dirname}/example-files/apispec_1.json`,
    serversPath: './apispe',
    mockFolder: './mocks',
    mockConfig: {
      // msw: true,
    },
  });
};
gen();
