import { existsSync, readFileSync } from 'fs';
import glob from 'glob';
import { camelCase, isBoolean, isArray, upperFirst } from 'lodash';
import * as nunjucks from 'nunjucks';
import type {
  ContentObject,
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
} from 'openapi3-ts';
import { join } from 'path';
import ReservedDict from 'reserved-words';
import rimraf from 'rimraf';
import pinyin from 'tiny-pinyin';
import numberToWords from 'number-to-words';
import type { GenerateServiceProps } from './index';
import Log from './log';
import { stripDot, writeFile } from './util';

const BASE_DIRS = ['service', 'services'];

export type TypescriptFileType = 'interface' | 'serviceController' | 'serviceIndex';

export interface APIDataType extends OperationObject {
  path: string;
  method: string;
}

export type TagAPIDataType = Record<string, APIDataType[]>;

type ReactQueryTemplateConfig = {
  importPath: string;
  mutation: boolean;
};

/** 页码入参名，Spring 里可能平铺为 `page`，也可能嵌在 `pageable` 对象中 */
const PAGE_PARAM_NAME = 'page';
/** 首页页码，Spring Data Pageable 从 0 开始 */
const FIRST_PAGE_PARAM = 0;
/** 分页返回体中列表字段的候选名 */
const PAGE_CONTENT_FIELDS = ['content', 'records', 'list', 'items', 'rows'];
/** 分页元信息可能嵌套在这些字段下（如 springdoc 的 PagedModel.page） */
const PAGE_METADATA_FIELDS = ['page', 'pageInfo', 'page_info', 'meta', 'metadata', 'pageable'];
/** 分页返回体中当前页码字段的候选名 */
const PAGE_NUMBER_FIELDS = ['number', 'pageNumber', 'page_number', 'pageNum', 'page', 'current'];
/** 分页返回体中总页数字段的候选名 */
const PAGE_TOTAL_PAGES_FIELDS = ['totalPages', 'total_pages', 'pages'];
/** 分页返回体中「是否最后一页」字段的候选名 */
const PAGE_LAST_FIELDS = ['last', 'isLast', 'is_last'];
/** 分页返回体被壳结构包裹时，数据字段的候选名 */
const DEFAULT_DATA_FIELDS = ['data', 'result', 'res'];

export interface MappingItemType {
  antTechApi: string;
  popAction: string;
  popProduct: string;
  antTechVersion: string;
}

export interface ControllerType {
  fileName: string;
  controllerName: string;
}

export const getPath = () => {
  const cwd = process.cwd();
  return existsSync(join(cwd, 'src')) ? join(cwd, 'src') : cwd;
};

// 兼容C#泛型的typeLastName取法
function getTypeLastName(typeName) {
  const tempTypeName = typeName || '';

  const childrenTypeName = tempTypeName?.match(/\[\[.+\]\]/g)?.[0];
  if (!childrenTypeName) {
    let publicKeyToken = (tempTypeName.split('PublicKeyToken=')?.[1] ?? '').replace('null', '');
    const firstTempTypeName = tempTypeName.split(',')?.[0] ?? tempTypeName;
    let typeLastName = firstTempTypeName.split('/').pop().split('.').pop();
    if (typeLastName.endsWith('[]')) {
      typeLastName = typeLastName.substring(0, typeLastName.length - 2) + 'Array';
    }
    // 特殊处理C#默认系统类型，不追加publicKeyToken
    const isCsharpSystemType = firstTempTypeName.startsWith('System.');
    if (!publicKeyToken || isCsharpSystemType) {
      return typeLastName;
    }
    return `${typeLastName}_${publicKeyToken}`;
  }
  const currentTypeName = getTypeLastName(tempTypeName.replace(childrenTypeName, ''));
  const childrenTypeNameLastName = getTypeLastName(
    childrenTypeName.substring(2, childrenTypeName.length - 2),
  );
  return `${currentTypeName}_${childrenTypeNameLastName}`;
}

// 类型声明过滤关键字
const resolveTypeName = (typeName: string) => {
  if (ReservedDict.check(typeName)) {
    return `__openAPI__${typeName}`;
  }
  const typeLastName = getTypeLastName(typeName);

  let name = typeLastName
    .replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase())
    .replace(/[^\w^\s^\u4e00-\u9fa5]/gi, '');

  // 当model名称是number开头的时候，ts会报错。这种场景一般发生在后端定义的名称是中文
  if (name === '_' || /^\d+$/.test(name)) {
    Log('⚠️  models不能以number开头，原因可能是Model定义名称为中文, 建议联系后台修改');
    return `Pinyin_${name}`;
  }
  // 前面的解析可能会吧类似"2.0"之类的tag文字解析成首字母带数字的key
  // 后面要是再带点别的字符在生成ts className的时候会由于首字符带数字导致非法变量报错
  // 这里做一个统一处理
  if (/^\d/.test(name)) {
    const firstChar = parseInt(name[0]);
    name = `${numberToWords.toWords(firstChar)}${name.substring(1)}`;
  }

  if (!/[\u3220-\uFA29]/.test(name) && !/^\d$/.test(name)) {
    return name;
  }
  const noBlankName = name.replace(/ +/g, '');
  return pinyin.convertToPinyin(noBlankName, '', true);
};

function getRefName(refObject: any): string {
  if (typeof refObject !== 'object' || !refObject.$ref) {
    return refObject;
  }
  const refPaths = refObject.$ref.split('/');
  return resolveTypeName(refPaths[refPaths.length - 1]) as string;
}

const defaultGetType = (schemaObject: SchemaObject | undefined, namespace: string = ''): string => {
  if (schemaObject === undefined || schemaObject === null) {
    return 'any';
  }
  if (typeof schemaObject !== 'object') {
    return schemaObject;
  }
  if (schemaObject.$ref) {
    return [namespace, getRefName(schemaObject)].filter((s) => s).join('.');
  }

  let { type } = schemaObject as any;

  const numberEnum = [
    'integer',
    'long',
    'float',
    'double',
    'number',
    'int',
    'float',
    'double',
    'int32',
    'int64',
  ];

  const dateEnum = ['Date', 'date', 'dateTime', 'date-time', 'datetime'];

  const stringEnum = ['string', 'email', 'password', 'url', 'byte', 'binary'];

  if (type === 'null') {
    return 'null';
  }

  if (numberEnum.includes(schemaObject.format)) {
    type = 'number';
  }

  if (schemaObject.enum) {
    type = 'enum';
  }

  if (numberEnum.includes(type)) {
    return 'number';
  }

  if (dateEnum.includes(type)) {
    return 'Date';
  }

  if (stringEnum.includes(type)) {
    return 'string';
  }

  if (type === 'boolean') {
    return 'boolean';
  }

  if (type === 'array') {
    let { items } = schemaObject;
    if (schemaObject.schema) {
      items = schemaObject.schema.items;
    }

    if (Array.isArray(items)) {
      const arrayItemType = (items as any)
        .map((subType) => defaultGetType(subType.schema || subType, namespace))
        .toString();
      return `[${arrayItemType}]`;
    }
    const arrayType = defaultGetType(items, namespace);
    return arrayType.includes(' | ') ? `(${arrayType})[]` : `${arrayType}[]`;
  }

  if (type === 'enum') {
    return Array.isArray(schemaObject.enum)
      ? Array.from(
          new Set(
            schemaObject.enum.map((v) =>
              typeof v === 'string' ? `"${v.replace(/"/g, '"')}"` : defaultGetType(v),
            ),
          ),
        ).join(' | ')
      : 'string';
  }

  if (schemaObject.oneOf && schemaObject.oneOf.length) {
    return schemaObject.oneOf.map((item) => defaultGetType(item, namespace)).join(' | ');
  }
  if (schemaObject.anyOf && schemaObject.anyOf.length) {
    return schemaObject.anyOf.map((item) => defaultGetType(item, namespace)).join(' | ');
  }
  if (schemaObject.allOf && schemaObject.allOf.length) {
    return `(${schemaObject.allOf.map((item) => defaultGetType(item, namespace)).join(' & ')})`;
  }
  if (schemaObject.type === 'object' || schemaObject.properties) {
    if (!Object.keys(schemaObject.properties || {}).length) {
      return 'Record<string, any>';
    }
    return `{ ${Object.keys(schemaObject.properties)
      .map((key) => {
        let required = false;
        if (isBoolean(schemaObject.required) && schemaObject.required) {
          required = true;
        }
        if (isArray(schemaObject.required) && schemaObject.required.includes(key)) {
          required = true;
        }
        if (
          'required' in (schemaObject.properties[key] || {}) &&
          ((schemaObject.properties[key] || {}) as any).required
        ) {
          required = true;
        }
        /**
         * 将类型属性变为字符串，兼容错误格式如：
         * 3d_tile(数字开头)等错误命名，
         * 在后面进行格式化的时候会将正确的字符串转换为正常形式，
         * 错误的继续保留字符串。
         * */
        return `'${key}'${required ? '' : '?'}: ${defaultGetType(
          schemaObject.properties && schemaObject.properties[key],
          namespace,
        )}; `;
      })
      .join('')}}`;
  }
  return 'any';
};

export const getGenInfo = (isDirExist: boolean, appName: string, absSrcPath: string) => {
  // dir 不存在，则没有占用，且为第一次
  if (!isDirExist) {
    return [false, true];
  }
  const indexList = glob.sync(`@(${BASE_DIRS.join('|')})/${appName}/index.@(js|ts)`, {
    cwd: absSrcPath,
  });
  // dir 存在，且 index 存在
  if (indexList && indexList.length) {
    const indexFile = join(absSrcPath, indexList[0]);
    try {
      const line = (readFileSync(indexFile, 'utf-8') || '').split(/\r?\n/).slice(0, 3).join('');
      // dir 存在，index 存在， 且 index 是我们生成的。则未占用，且不是第一次
      if (line.includes('// API 更新时间：')) {
        return [false, false];
      }
      // dir 存在，index 存在，且 index 内容不是我们生成的。此时如果 openAPI 子文件存在，就不是第一次，否则是第一次
      return [true, !existsSync(join(indexFile, 'openAPI'))];
    } catch (e) {
      // 因为 glob 已经拿到了这个文件，但没权限读，所以当作 dirUsed, 在子目录重新新建，所以当作 firstTime
      return [true, true];
    }
  }
  // dir 存在，index 不存在, 冲突，第一次要看 dir 下有没有 openAPI 文件夹
  return [
    true,
    !(
      existsSync(join(absSrcPath, BASE_DIRS[0], appName, 'openAPI')) ||
      existsSync(join(absSrcPath, BASE_DIRS[1], appName, 'openAPI'))
    ),
  ];
};

const DEFAULT_SCHEMA: SchemaObject = {
  type: 'object',
  properties: { id: { type: 'number' } },
};

const DEFAULT_PATH_PARAM: ParameterObject = {
  in: 'path',
  name: null,
  schema: {
    type: 'string',
  },
  required: true,
  isObject: false,
  type: 'string',
};

function defaultGetFileTag(operationObject: OperationObject, apiPath: string, _apiMethod: string) {
  return operationObject['x-swagger-router-controller']
    ? [operationObject['x-swagger-router-controller']]
    : operationObject.tags || [operationObject.operationId] || [
          apiPath.replace('/', '').split('/')[1],
        ];
}
class ServiceGenerator {
  protected apiData: TagAPIDataType = {};

  protected classNameList: ControllerType[] = [];

  protected version: string;

  protected mappings: MappingItemType[] = [];

  protected finalPath: string;

  protected config: GenerateServiceProps;
  protected openAPIData: OpenAPIObject;

  constructor(config: GenerateServiceProps, openAPIData: OpenAPIObject) {
    this.finalPath = '';
    this.config = {
      projectName: 'api',
      templatesFolder: join(__dirname, '../', 'templates'),
      ...config,
    };
    if (this.config.hook?.afterOpenApiDataInited) {
      this.openAPIData = this.config.hook.afterOpenApiDataInited(openAPIData) || openAPIData;
    } else {
      this.openAPIData = openAPIData;
    }
    const { info } = this.openAPIData;
    const basePath = '';
    this.version = info.version;
    const hookCustomFileNames = this.config.hook?.customFileNames || defaultGetFileTag;
    Object.keys(this.openAPIData.paths || {}).forEach((p) => {
      const pathItem: PathItemObject = this.openAPIData.paths[p];
      ['get', 'put', 'post', 'delete', 'patch'].forEach((method) => {
        const operationObject: OperationObject = pathItem[method];
        if (!operationObject) {
          return;
        }

        let tags = hookCustomFileNames(operationObject, p, method);
        if (!tags) {
          tags = defaultGetFileTag(operationObject, p, method);
        }

        tags.forEach((tagString) => {
          const tag = this.config.isCamelCase
            ? camelCase(resolveTypeName(tagString))
            : resolveTypeName(tagString);

          if (!this.apiData[tag]) {
            this.apiData[tag] = [];
          }
          this.apiData[tag].push({
            path: `${basePath}${p}`,
            method,
            ...operationObject,
          });
        });
      });
    });
  }

  public genFile() {
    const basePath = this.config.serversPath || './src/service';
    try {
      const finalPath = join(basePath, this.config.projectName);

      this.finalPath = finalPath;
      glob
        .sync(`${finalPath}/**/*`)
        .filter((ele) => !ele.includes('_deperated'))
        .forEach((ele) => {
          rimraf.sync(ele);
        });
    } catch (error) {
      Log(`🚥 serves 生成失败: ${error}`);
    }
    // 生成 ts 类型声明
    this.genFileFromTemplate('typings.d.ts', 'interface', {
      namespace: this.config.namespace,
      nullable: this.config.nullable,
      // namespace: 'API',
      list: this.getInterfaceTP(),
      disableTypeCheck: false,
      declareType: this.config.declareType || 'type',
      equalSymbol: (this.config.declareType || 'type') === 'type' ? '=' : '',
    });
    // 生成 controller 文件
    const prettierError = [];
    const reactQuery = this.getReactQueryConfig();
    // 生成 service 统计
    this.getServiceTP().forEach((tp) => {
      // 根据当前数据源类型选择恰当的 controller 模版
      const template = 'serviceController';
      const hasError = this.genFileFromTemplate(
        this.getFinalFileName(`${tp.className}.ts`),
        template,
        {
          namespace: this.config.namespace,
          requestOptionsType: this.config.requestOptionsType,
          requestImportStatement: this.config.requestImportStatement,
          reactQuery,
          disableTypeCheck: false,
          ...tp,
        },
      );
      prettierError.push(hasError);
    });

    if (prettierError.includes(true)) {
      Log(`🚥 格式化失败，请检查 service 文件内可能存在的语法错误`);
    }
    // 生成 index 文件
    this.genFileFromTemplate(`index.ts`, 'serviceIndex', {
      list: this.classNameList,
      disableTypeCheck: false,
    });

    // 打印日志
    Log(`✅ 成功生成 service 文件`);
  }

  public concatOrNull = (...arrays) => {
    const c = [].concat(...arrays.filter(Array.isArray));
    return c.length > 0 ? c : null;
  };

  private getReactQueryConfig(): ReactQueryTemplateConfig | null {
    const config = this.config.reactQuery;
    if (!config) {
      return null;
    }
    return {
      importPath: '@tanstack/react-query',
      mutation: false,
      ...(typeof config === 'boolean' ? {} : config),
    };
  }

  /** 顺着 $ref 找到真正的 schema 定义 */
  private dereferenceSchema(schema: SchemaObject | ReferenceObject): SchemaObject | null {
    let current: any = schema;
    let depth = 0;
    while (current?.$ref && depth < 10) {
      const refName = current.$ref.split('/').pop();
      current = this.openAPIData.components?.schemas?.[refName];
      depth += 1;
    }
    return (current as SchemaObject) || null;
  }

  /** 展开 $ref 与 allOf，得到 schema 的属性集合 */
  private getSchemaProperties(
    schema: SchemaObject | ReferenceObject | undefined,
    depth = 0,
  ): Record<string, SchemaObject> | null {
    const resolved = schema && depth < 10 && this.dereferenceSchema(schema);
    if (!resolved) {
      return null;
    }
    let props = resolved.properties ? { ...resolved.properties } : null;
    (resolved.allOf || []).forEach((item) => {
      const itemProps = this.getSchemaProperties(item, depth + 1);
      if (itemProps) {
        props = { ...(props || {}), ...itemProps };
      }
    });
    return props as Record<string, SchemaObject> | null;
  }

  private isScalarSchema(schema: SchemaObject | ReferenceObject | undefined) {
    const type = schema && this.dereferenceSchema(schema)?.type;
    return !!type && type !== 'object' && type !== 'array';
  }

  /** 从分页元信息的属性集合中挑出页码、总页数等字段名 */
  private matchPageMetaFields(props: Record<string, SchemaObject>) {
    const findScalar = (candidates: string[]) =>
      candidates.find((field) => props[field] && this.isScalarSchema(props[field]));
    const pageNumberField = findScalar(PAGE_NUMBER_FIELDS);
    const totalPagesField = findScalar(PAGE_TOTAL_PAGES_FIELDS);
    const lastField = findScalar(PAGE_LAST_FIELDS);
    if (!pageNumberField && !totalPagesField && !lastField) {
      return null;
    }
    return { pageNumberField, totalPagesField, lastField };
  }

  /** 判断 schema 是否为分页结构（Spring Data Page / PagedModel 及类似结构），并返回其关键字段名 */
  private matchPageSchema(schema: SchemaObject | ReferenceObject | undefined) {
    const props = this.getSchemaProperties(schema);
    if (!props) {
      return null;
    }
    const contentField = PAGE_CONTENT_FIELDS.find(
      (field) => this.dereferenceSchema(props[field])?.type === 'array',
    );
    if (!contentField) {
      return null;
    }
    // 元信息可能嵌在子对象里（PagedModel.page），也可能与 content 平铺（Page）
    for (const metaField of PAGE_METADATA_FIELDS) {
      const metaProps = this.getSchemaProperties(props[metaField]);
      const fields = metaProps && this.matchPageMetaFields(metaProps);
      if (fields) {
        return { contentField, metadataPath: [metaField], ...fields };
      }
    }
    const fields = this.matchPageMetaFields(props);
    return fields ? { contentField, metadataPath: [] as string[], ...fields } : null;
  }

  /**
   * 定位响应体中的分页结构。
   * dataPath 表示在「生成的返回类型」上访问分页对象所需的字段路径，
   * 若已通过 dataFields 拆包，则为空数组。
   */
  private getPageSchemaInfo(responses: ResponsesObject = {}) {
    const response: ResponseObject | undefined =
      responses && this.resolveRefObject(responses.default || responses['200'] || responses['201']);
    const resContent: ContentObject | undefined = response?.content;
    const mediaTypes = Object.keys(resContent || {});
    const mediaType = mediaTypes.includes('application/json') ? 'application/json' : mediaTypes[0];
    if (!resContent || !mediaType || !resContent[mediaType].schema) {
      return null;
    }
    const rootSchema = resContent[mediaType].schema as SchemaObject;
    const wrapperProps = this.getSchemaProperties(rootSchema);

    // dataFields 已拆包时，生成的返回类型就是分页对象本身
    if (this.config.dataFields?.length && rootSchema.$ref && wrapperProps) {
      const unwrapped = this.config.dataFields
        .map((field) => wrapperProps[field])
        .filter(Boolean)?.[0];
      const matched = unwrapped && this.matchPageSchema(unwrapped);
      if (matched) {
        return { ...matched, dataPath: [] as string[] };
      }
    }

    const direct = this.matchPageSchema(rootSchema);
    if (direct) {
      return { ...direct, dataPath: [] as string[] };
    }

    // 形如 GeneralOperationResult<Page<T>> 的壳结构
    if (wrapperProps) {
      const dataFields = this.config.dataFields?.length
        ? this.config.dataFields
        : DEFAULT_DATA_FIELDS;
      for (const field of dataFields) {
        const matched = this.matchPageSchema(wrapperProps[field]);
        if (matched) {
          return { ...matched, dataPath: [field] };
        }
      }
    }
    return null;
  }

  /**
   * 定位页码入参。既支持平铺的 `page` 参数，
   * 也支持 Spring 里以对象形式出现的 `pageable` 参数（page 嵌在其中）。
   */
  private getPageParamInfo(params: Record<string, ParameterObject[]>) {
    const queryParams = (params?.query || []) as (ParameterObject & {
      isObject?: boolean;
      type?: string;
    })[];
    const flat = queryParams.find((p) => p.name === PAGE_PARAM_NAME);
    if (flat && this.isScalarSchema(flat.schema)) {
      return { pageParamName: flat.name, nestedPageField: null, pageParamType: null };
    }
    const nested = queryParams.find(
      (p) => p.isObject && this.getSchemaProperties(p.schema)?.[PAGE_PARAM_NAME],
    );
    if (nested) {
      return {
        pageParamName: nested.name,
        nestedPageField: PAGE_PARAM_NAME,
        pageParamType: nested.type,
      };
    }
    return null;
  }

  /** 生成 useInfiniteQuery 所需的模板数据，不满足分页特征时返回 null */
  private getInfiniteQueryTP(api: APIDataType, params: Record<string, ParameterObject[]>) {
    const pageParam = this.getPageParamInfo(params);
    if (!pageParam) {
      return null;
    }
    const pageSchema = this.getPageSchemaInfo(api.responses);
    if (!pageSchema) {
      return null;
    }
    return {
      ...pageSchema,
      ...pageParam,
      firstPageParam: FIRST_PAGE_PARAM,
    };
  }

  public getFuncationName(data: APIDataType) {
    // 获取路径相同部分
    const pathBasePrefix = this.getBasePrefix(Object.keys(this.openAPIData.paths));
    return this.config.hook && this.config.hook.customFunctionName
      ? this.config.hook.customFunctionName(data)
      : data.operationId
      ? this.resolveFunctionName(stripDot(data.operationId), data.method)
      : data.method + this.genDefaultFunctionName(data.path, pathBasePrefix);
  }

  public getTypeName(data: APIDataType) {
    const namespace = this.config.namespace ? `${this.config.namespace}.` : '';
    const typeName = this.config?.hook?.customTypeName?.(data) || this.getFuncationName(data);

    return resolveTypeName(`${namespace}${typeName ?? data.operationId}Params`);
  }

  public getServiceTP() {
    return Object.keys(this.apiData)
      .map((tag, index) => {
        // functionName tag 级别防重
        const tmpFunctionRD: Record<string, number> = {};

        const genParams = this.apiData[tag]
          .filter(
            (api) =>
              // 暂不支持变量
              !api.path.includes('${'),
          )
          .map((api) => {
            const newApi = api;
            try {
              const allParams = this.getParamsTP(newApi.parameters, newApi.path);
              const body = this.getBodyTP(newApi.requestBody);
              const response = this.getResponseTP(newApi.responses);

              // let { file, ...params } = allParams || {}; // I dont't know if 'file' is valid parameter, maybe it's safe to remove it
              // const newfile = this.getFileTP(newApi.requestBody);
              // file = this.concatOrNull(file, newfile);
              const params = allParams || {};
              const file = this.getFileTP(newApi.requestBody);

              let formData = false;
              if ((body && (body.mediaType || '').includes('form-data')) || file) {
                formData = true;
              }

              let functionName = this.getFuncationName(newApi);

              if (functionName && tmpFunctionRD[functionName]) {
                functionName = `${functionName}_${(tmpFunctionRD[functionName] += 1)}`;
              } else if (functionName) {
                tmpFunctionRD[functionName] = 1;
              }

              let formattedPath = newApi.path.replace(
                /:([^/]*)|{([^}]*)}/gi,
                (_, str, str2) => `$\{${str || str2}}`,
              );
              if (newApi.extensions && newApi.extensions['x-antTech-description']) {
                const { extensions } = newApi;
                const { apiName, antTechVersion, productCode, antTechApiName } = extensions[
                  'x-antTech-description'
                ];
                formattedPath = antTechApiName || formattedPath;
                this.mappings.push({
                  antTechApi: formattedPath,
                  popAction: apiName,
                  popProduct: productCode,
                  antTechVersion,
                });
                newApi.antTechVersion = antTechVersion;
              }

              // 为 path 中的 params 添加 alias
              const escapedPathParams = ((params || {}).path || []).map((ele, index) => ({
                ...ele,
                alias: `param${index}`,
              }));
              if (escapedPathParams.length) {
                escapedPathParams.forEach((param) => {
                  formattedPath = formattedPath.replace(`$\{${param.name}}`, `$\{${param.alias}}`);
                });
              }

              const finalParams =
                escapedPathParams && escapedPathParams.length
                  ? { ...params, path: escapedPathParams }
                  : params;

              // 处理 query 中的复杂对象
              if (finalParams && finalParams.query) {
                finalParams.query = finalParams.query.map((ele) => ({
                  ...ele,
                  isComplexType: ele.isObject,
                }));
              }

              const getPrefixPath = () => {
                if (!this.config.apiPrefix) {
                  return formattedPath;
                }
                // 静态 apiPrefix
                const prefix =
                  typeof this.config.apiPrefix === 'function'
                    ? `${this.config.apiPrefix({
                        path: formattedPath,
                        method: newApi.method,
                        namespace: tag,
                        functionName,
                      })}`.trim()
                    : this.config.apiPrefix.trim();

                if (!prefix) {
                  return formattedPath;
                }

                if (prefix.startsWith("'") || prefix.startsWith('"') || prefix.startsWith('`')) {
                  const finalPrefix = prefix.slice(1, prefix.length - 1);
                  if (
                    formattedPath.startsWith(finalPrefix) ||
                    formattedPath.startsWith(`/${finalPrefix}`)
                  ) {
                    return formattedPath;
                  }
                  return `${finalPrefix}${formattedPath}`;
                }
                // prefix 变量
                return `$\{${prefix}}${formattedPath}`;
              };

              const finalFunctionName = this.config.isCamelCase
                ? camelCase(functionName)
                : functionName;

              const isQuery = newApi.method.toLowerCase() === 'get';
              const infiniteQuery = isQuery ? this.getInfiniteQueryTP(newApi, finalParams) : null;

              return {
                ...newApi,
                functionName: finalFunctionName,
                isQuery,
                queryKeyName: `get${upperFirst(finalFunctionName)}QueryKey`,
                queryHookName: `use${upperFirst(finalFunctionName)}Query`,
                infiniteQuery,
                infiniteQueryKeyName: `get${upperFirst(finalFunctionName)}InfiniteQueryKey`,
                infiniteQueryHookName: `use${upperFirst(finalFunctionName)}InfiniteQuery`,
                mutationHookName: `use${upperFirst(finalFunctionName)}Mutation`,
                mutationVariablesTypeName: `${upperFirst(finalFunctionName)}MutationVariables`,
                typeName: this.getTypeName(newApi),
                path: getPrefixPath(),
                pathInComment: formattedPath.replace(/\*/g, '&#42;'),
                hasPathVariables: formattedPath.includes('{'),
                hasApiPrefix: !!this.config.apiPrefix,
                method: newApi.method,
                // 如果 functionName 和 summary 相同，则不显示 summary
                desc:
                  functionName === newApi.summary
                    ? newApi.description
                    : [
                        newApi.summary,
                        newApi.description,
                        (newApi.responses?.default as ResponseObject)?.description
                          ? `返回值: ${(newApi.responses?.default as ResponseObject).description}`
                          : '',
                      ]
                        .filter((s) => s)
                        .join(' '),
                hasHeader: !!(params && params.header) || !!(body && body.mediaType),
                params: finalParams,
                hasParams: Boolean(Object.keys(finalParams || {}).length),
                options: this.config.hook?.customOptionsDefaultValue?.(newApi) || {},
                body,
                file,
                hasFormData: formData,
                response,
              };
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error('[GenSDK] gen service param error:', error);
              throw error;
            }
          })
          // 排序下，要不每次git都乱了
          .sort((a, b) => a.path.localeCompare(b.path));

        const fileName = this.replaceDot(tag) || `api${index}`;

        let className = fileName;
        if (this.config.hook && this.config.hook.customClassName) {
          className = this.config.hook.customClassName(tag);
        }
        if (genParams.length) {
          this.classNameList.push({
            fileName: className,
            controllerName: className,
          });
        }
        return {
          genType: 'ts',
          className,
          hasQuery: genParams.some((api) => api.isQuery),
          hasInfiniteQuery: genParams.some((api) => !!api.infiniteQuery),
          hasMutation: genParams.some((api) => !api.isQuery),
          instanceName: `${fileName[0]?.toLowerCase()}${fileName.substr(1)}`,
          list: genParams,
        };
      })
      .filter((ele) => !!ele?.list?.length);
  }

  public getBodyTP(requestBody: any = {}) {
    const reqBody: RequestBodyObject = this.resolveRefObject(requestBody);
    if (!reqBody) {
      return null;
    }
    const reqContent: ContentObject = reqBody.content;
    if (typeof reqContent !== 'object' || (reqContent && Object.keys(reqContent).length === 0)) {
      return null;
    }
    let mediaType = Object.keys(reqContent)[0];

    const schema: SchemaObject = reqContent[mediaType].schema || DEFAULT_SCHEMA;

    if (mediaType === '*/*') {
      mediaType = '';
    }
    // 如果 requestBody 有 required 属性，则正常展示；如果没有，默认非必填
    const required = typeof requestBody.required === 'boolean' ? requestBody.required : false;
    if (schema.type === 'object' && schema.properties) {
      const propertiesList = Object.keys(schema.properties)
        .map((p) => {
          if (
            schema.properties &&
            schema.properties[p] &&
            !['binary', 'base64'].includes((schema.properties[p] as SchemaObject).format || '') &&
            !(
              ['string[]', 'array'].includes((schema.properties[p] as SchemaObject).type || '') &&
              ['binary', 'base64'].includes(
                ((schema.properties[p] as SchemaObject).items as SchemaObject).format || '',
              )
            )
          ) {
            return {
              key: p,
              schema: {
                ...schema.properties[p],
                type: this.getType(schema.properties[p], this.config.namespace),
                required: schema.required?.includes(p) ?? false,
              },
            };
          }
          return undefined;
        })
        .filter((p) => p);
      return {
        mediaType,
        ...schema,
        required,
        propertiesList,
      };
    }
    return {
      mediaType,
      required,
      type: this.getType(schema, this.config.namespace),
    };
  }
  public getFileTP(requestBody: any = {}) {
    const reqBody: RequestBodyObject = this.resolveRefObject(requestBody);
    if (reqBody && reqBody.content && reqBody.content['multipart/form-data']) {
      const ret = this.resolveFileTP(reqBody.content['multipart/form-data'].schema);
      return ret.length > 0 ? ret : null;
    }
    return null;
  }
  public resolveFileTP(obj: any) {
    let ret = [];
    const resolved = this.resolveObject(obj);
    const props =
      (resolved.props &&
        resolved.props.length > 0 &&
        resolved.props[0].filter(
          (p) =>
            p.format === 'binary' ||
            p.format === 'base64' ||
            ((p.type === 'string[]' || p.type === 'array') &&
              (p.items.format === 'binary' || p.items.format === 'base64')),
        )) ||
      [];
    if (props.length > 0) {
      ret = props.map((p) => {
        return { title: p.name, multiple: p.type === 'string[]' || p.type === 'array' };
      });
    }
    if (resolved.type) ret = [...ret, ...this.resolveFileTP(resolved.type)];
    return ret;
  }

  public getResponseTP(responses: ResponsesObject = {}) {
    const { components } = this.openAPIData;
    const response: ResponseObject | undefined =
      responses && this.resolveRefObject(responses.default || responses['200'] || responses['201']);
    const defaultResponse = {
      mediaType: '*/*',
      type: 'any',
    };
    if (!response) {
      return defaultResponse;
    }
    const resContent: ContentObject | undefined = response.content;
    const resContentMediaTypes = Object.keys(resContent || {});
    const mediaType = resContentMediaTypes.includes('application/json')
      ? 'application/json'
      : resContentMediaTypes[0]; // 优先使用 application/json
    if (typeof resContent !== 'object' || !mediaType) {
      return defaultResponse;
    }
    let schema = (resContent[mediaType].schema || DEFAULT_SCHEMA) as SchemaObject;

    if (schema.$ref) {
      const refPaths = schema.$ref.split('/');
      const refName = refPaths[refPaths.length - 1];
      const childrenSchema = components.schemas[refName] as SchemaObject;
      if (
        childrenSchema?.type === 'object' &&
        'properties' in childrenSchema &&
        this.config.dataFields
      ) {
        schema =
          this.config.dataFields
            .map((field) => childrenSchema.properties[field])
            .filter(Boolean)?.[0] ||
          resContent[mediaType].schema ||
          DEFAULT_SCHEMA;
      }
    }

    if ('properties' in schema) {
      Object.keys(schema.properties).map((fieldName) => {
        // eslint-disable-next-line @typescript-eslint/dot-notation
        schema.properties[fieldName]['required'] = schema.required?.includes(fieldName) ?? false;
      });
    }
    return {
      mediaType,
      type: this.getType(schema, this.config.namespace),
    };
  }

  public getParamsTP(
    parameters: (ParameterObject | ReferenceObject)[] = [],
    path: string = null,
  ): Record<string, ParameterObject[]> {
    const templateParams: Record<string, ParameterObject[]> = {};

    if (parameters && parameters.length) {
      ['query', 'path', 'cookie' /* , 'file' */].forEach((source) => {
        // Possible values are "query", "header", "path" or "cookie". (https://swagger.io/specification/)
        const params = parameters
          .map((p) => this.resolveRefObject(p))
          .filter((p: ParameterObject) => p.in === source)
          .map((p) => {
            const isDirectObject = ((p.schema || {}).type || p.type) === 'object';
            const refList = ((p.schema || {}).$ref || p.$ref || '').split('/');
            const ref = refList[refList.length - 1];
            const deRefObj = (Object.entries(
              (this.openAPIData.components && this.openAPIData.components.schemas) || {},
            ).find(([k]) => k === ref) || []) as any;
            const isRefObject = (deRefObj[1] || {}).type === 'object';
            return {
              ...p,
              isObject: isDirectObject || isRefObject,
              type: this.getType(p.schema || DEFAULT_SCHEMA, this.config.namespace),
            };
          });

        if (params.length) {
          templateParams[source] = params;
        }
      });
    }

    if (path && path.length > 0) {
      const regex = /\{(\w+)\}/g;
      templateParams.path = templateParams.path || [];
      let match = null;
      while ((match = regex.exec(path))) {
        if (!templateParams.path.some((p) => p.name === match[1])) {
          templateParams.path.push({
            ...DEFAULT_PATH_PARAM,
            name: match[1],
          });
        }
      }

      // 如果 path 没有内容，则将删除 path 参数，避免影响后续的 hasParams 判断
      if (!templateParams.path.length) delete templateParams.path;
    }

    return templateParams;
  }

  public getInterfaceTP() {
    const { components } = this.openAPIData;
    const data =
      components &&
      components.schemas &&
      [components.schemas].map((defines) => {
        if (!defines) {
          return null;
        }

        return Object.keys(defines).map((typeName) => {
          const result = this.resolveObject(defines[typeName]);

          const getDefinesType = () => {
            if (result.type) {
              return (defines[typeName] as SchemaObject).type === 'object' || result.type;
            }
            return 'Record<string, any>';
          };
          return {
            typeName: resolveTypeName(typeName),
            type: getDefinesType(),
            parent: result.parent,
            props: result.props || [],
            isEnum: result.isEnum,
          };
        });
      });

    // 强行替换掉请求参数params的类型，生成方法对应的 xxxxParams 类型
    Object.keys(this.openAPIData.paths || {}).forEach((p) => {
      const pathItem: PathItemObject = this.openAPIData.paths[p];
      ['get', 'put', 'post', 'delete', 'patch'].forEach((method) => {
        const operationObject: OperationObject = pathItem[method];
        if (!operationObject) {
          return;
        }
        operationObject.parameters = operationObject.parameters?.filter(
          (item) => (item as ParameterObject)?.in !== 'header',
        );
        const props = [];
        if (operationObject.parameters) {
          operationObject.parameters.forEach((parameter: any) => {
            props.push({
              desc: parameter.description ?? '',
              name: parameter.name,
              required: parameter.required,
              type: this.getType(parameter.schema),
            });
          });
        }
        // parameters may be in path
        if (pathItem.parameters) {
          pathItem.parameters.forEach((parameter: any) => {
            props.push({
              desc: parameter.description ?? '',
              name: parameter.name,
              required: parameter.required,
              type: this.getType(parameter.schema),
            });
          });
        }

        if (props.length > 0 && data) {
          data.push([
            {
              typeName: this.getTypeName({ ...operationObject, method, path: p }),
              type: 'Record<string, any>',
              parent: undefined,
              props: [props],
              isEnum: false,
            },
          ]);
        }
      });
    });
    // ---- 生成 xxxparams 类型 end---------

    return (
      data &&
      data
        .reduce((p, c) => p && c && p.concat(c), [])
        // 排序下，要不每次git都乱了
        .sort((a, b) => a.typeName.localeCompare(b.typeName))
    );
  }

  private genFileFromTemplate(
    fileName: string,
    type: TypescriptFileType,
    params: Record<string, any>,
  ): boolean {
    try {
      const template = this.getTemplate(type);
      // 设置输出不转义
      nunjucks.configure({
        autoescape: false,
      });
      return writeFile(this.finalPath, fileName, nunjucks.renderString(template, params));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[GenSDK] file gen fail:', fileName, 'type:', type);
      throw error;
    }
  }

  private getTemplate(type: 'interface' | 'serviceController' | 'serviceIndex'): string {
    return readFileSync(join(this.config.templatesFolder, `${type}.njk`), 'utf8');
  }

  // 获取 TS 类型的属性列表
  getProps(schemaObject: SchemaObject) {
    const requiredPropKeys = schemaObject?.required ?? false;
    return schemaObject.properties
      ? Object.keys(schemaObject.properties).map((propName) => {
          const schema: SchemaObject =
            (schemaObject.properties && schemaObject.properties[propName]) || DEFAULT_SCHEMA;
          // 剔除属性键值中的特殊符号，因为函数入参变量存在特殊符号会导致解析文件失败
          propName = propName.replace(/[\[|\]]/g, '');
          return {
            ...schema,
            name: propName,
            type: this.getType(schema),
            desc: [schema.title, schema.description].filter((s) => s).join(' '),
            // 如果没有 required 信息，默认全部是非必填
            required: requiredPropKeys ? requiredPropKeys.some((key) => key === propName) : false,
          };
        })
      : [];
  }

  getType(schemaObject: SchemaObject | undefined, namespace?: string) {
    const hookFunc = this.config.hook?.customType;
    if (hookFunc) {
      const type = hookFunc(schemaObject, namespace, defaultGetType);
      if (typeof type === 'string') {
        return type;
      }
    }
    return defaultGetType(schemaObject, namespace);
  }

  resolveObject(schemaObject: SchemaObject) {
    schemaObject = schemaObject ?? {};
    // 引用类型
    if (schemaObject.$ref) {
      return this.resolveRefObject(schemaObject);
    }
    // 枚举类型
    if (schemaObject.enum) {
      return this.resolveEnumObject(schemaObject);
    }
    // 继承类型
    if (schemaObject.allOf && schemaObject.allOf.length) {
      return this.resolveAllOfObject(schemaObject);
    }
    // 对象类型
    if (schemaObject.properties) {
      return this.resolveProperties(schemaObject);
    }
    // 数组类型
    if (schemaObject.items && schemaObject.type === 'array') {
      return this.resolveArray(schemaObject);
    }
    return schemaObject;
  }

  resolveArray(schemaObject: SchemaObject) {
    if (schemaObject.items.$ref) {
      const refObj = schemaObject.items.$ref.split('/');
      return {
        type: `${refObj[refObj.length - 1]}[]`,
      };
    }
    // TODO: 这里需要解析出具体属性，但由于 parser 层还不确定，所以暂时先返回 any
    return 'any[]';
  }

  resolveProperties(schemaObject: SchemaObject) {
    return {
      props: [this.getProps(schemaObject)],
    };
  }

  resolveEnumObject(schemaObject: SchemaObject) {
    const enumArray = schemaObject.enum;

    let enumStr;
    switch (this.config.enumStyle) {
      case 'enum':
        enumStr = `{${enumArray.map((v) => `${v}="${v}"`).join(',')}}`;
        break;
      case 'string-literal':
        enumStr = Array.from(
          new Set(
            enumArray.map((v) =>
              typeof v === 'string' ? `"${v.replace(/"/g, '"')}"` : this.getType(v),
            ),
          ),
        ).join(' | ');
        break;
      default:
        break;
    }

    return {
      isEnum: this.config.enumStyle == 'enum',
      type: Array.isArray(enumArray) ? enumStr : 'string',
    };
  }

  resolveAllOfObject(schemaObject: SchemaObject) {
    const props = (schemaObject.allOf || []).map((item) =>
      item.$ref ? [{ ...item, type: this.getType(item).split('/').pop() }] : this.getProps(item),
    );

    if (schemaObject.properties) {
      const extProps = this.getProps(schemaObject);
      return { props: [...props, extProps] };
    }

    return { props };
  }

  // 将地址path路径转为大驼峰
  private genDefaultFunctionName(path: string, pathBasePrefix: string) {
    // 首字母转大写
    function toUpperFirstLetter(text: string) {
      return text.charAt(0).toUpperCase() + text.slice(1);
    }

    return path
      ?.replace(pathBasePrefix, '')
      .split('/')
      .map((str) => {
        /**
         * 兼容错误命名如 /user/:id/:name
         * 因为是typeName，所以直接进行转换
         * */
        let s = resolveTypeName(str);
        if (s.includes('-')) {
          s = s.replace(/(-\w)+/g, (_match: string, p1) => p1?.slice(1).toUpperCase());
        }

        if (s.match(/^{.+}$/gim)) {
          return `By${toUpperFirstLetter(s.slice(1, s.length - 1))}`;
        }
        return toUpperFirstLetter(s);
      })
      .join('');
  }
  // 检测所有path重复区域（prefix）
  private getBasePrefix(paths: string[]) {
    const arr = [];
    paths
      .map((item) => item.split('/'))
      .forEach((pathItem) => {
        pathItem.forEach((item, key) => {
          if (arr.length <= key) {
            arr[key] = [];
          }
          arr[key].push(item);
        });
      });

    const res = [];
    arr
      .map((item) => Array.from(new Set(item)))
      .every((item) => {
        const b = item.length === 1;
        if (b) {
          res.push(item);
        }
        return b;
      });

    return `${res.join('/')}/`;
  }

  private resolveRefObject(refObject: any): any {
    if (!refObject || !refObject.$ref) {
      return refObject;
    }
    const refPaths = refObject.$ref.split('/');
    if (refPaths[0] === '#') {
      refPaths.shift();
      let obj: any = this.openAPIData;
      refPaths.forEach((node: any) => {
        obj = obj[node];
      });
      if (!obj) {
        throw new Error(`[GenSDK] Data Error! Notfoud: ${refObject.$ref}`);
      }
      return {
        ...this.resolveRefObject(obj),
        type: obj.$ref ? this.resolveRefObject(obj).type : obj,
      };
    }
    return refObject;
  }

  private getFinalFileName(s: string): string {
    // 支持下划线、中划线和空格分隔符，注意分隔符枚举值的顺序不能改变，否则正则匹配会报错
    return s.replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase());
  }

  private replaceDot(s: string) {
    return s.replace(/\./g, '_').replace(/[-_ ](\w)/g, (_all, letter) => letter.toUpperCase());
  }

  private resolveFunctionName(functionName: string, methodName) {
    // 类型声明过滤关键字
    if (ReservedDict.check(functionName)) {
      return `${functionName}Using${methodName.toUpperCase()}`;
    }
    return functionName;
  }
}

export { ServiceGenerator };
