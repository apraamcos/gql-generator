#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const program = require('commander');
const { Source, buildSchema } = require('graphql');
const del = require('del');

program
  .option('--schemaFilePath [value]', 'path of your graphql schema file')
  .option('--destDirPath [value]', 'dir you want to store the generated queries')
  .option('--isAdmin [value]', 'give "true" if you want to build admin resolvers')
  .option('--isMobile [value]', 'give "true" if you want to build mobile resolvers')
  .option('--customisedQueryPath [value]', 'path of your customised queries')
  .option('--depthLimit [value]', 'query depth you want to limit(The default is 100)')
  .option('--ext [value]', 'extension file to use', 'gql')
  .option('-C, --includeDeprecatedFields [value]', 'Flag to include deprecated fields (The default is to exclude)')
  .parse(process.argv);

const {
  schemaFilePath,
  destDirPath,
  depthLimit = 100,
  isAdmin = '',
  isMobile = '',
  customisedQueryPath = '',
  includeDeprecatedFields = false,
  ext: fileExtension,
} = program;

const customisedQueries = [];
if (customisedQueryPath) {
  try {
    const customisedQueryFileNames = fs.readdirSync(customisedQueryPath);
    customisedQueryFileNames.forEach((x) => {
      const queries = fs
        .readFileSync(`${customisedQueryPath}/${x}`, { encoding: 'utf-8' })
        .split('\n')
        .filter((x) => x.trim().startsWith('mutation ') || x.trim().startsWith('query '))
        .map((x) => {
          return x.split('(')[0];
        })
        .map((x) => {
          return x.split(' ')[1];
        });
      customisedQueries.push(...queries);
    });
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}

const typeDef = fs.readFileSync(schemaFilePath, 'utf-8');
const source = new Source(typeDef);
const gqlSchema = buildSchema(source);

del.sync(destDirPath);
path
  .resolve(destDirPath)
  .split(path.sep)
  .reduce((before, cur) => {
    const pathTmp = path.join(before, cur + path.sep);
    if (!fs.existsSync(pathTmp)) {
      fs.mkdirSync(pathTmp);
    }
    return path.join(before, cur + path.sep);
  }, '');

/**
 * Compile arguments dictionary for a field
 * @param field current field object
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param allArgsDict dictionary of all arguments
 */
const getFieldArgsDict = (field, duplicateArgCounts, allArgsDict = {}) =>
  field.args.reduce((o, arg) => {
    if (arg.name in duplicateArgCounts) {
      const index = duplicateArgCounts[arg.name] + 1;
      duplicateArgCounts[arg.name] = index;
      o[`${arg.name}${index}`] = arg;
    } else if (allArgsDict[arg.name]) {
      duplicateArgCounts[arg.name] = 1;
      o[`${arg.name}1`] = arg;
    } else {
      o[arg.name] = arg;
    }
    return o;
  }, {});

/**
 * Generate variables string
 * @param dict dictionary of arguments
 */
const getArgsToVarsStr = (dict) =>
  Object.entries(dict)
    .map(([varName, arg]) => `${arg.name}: $${varName}`)
    .join(', ');

/**
 * Generate types string
 * @param dict dictionary of arguments
 */
const getVarsToTypesStr = (dict) =>
  Object.entries(dict)
    .map(([varName, arg]) => `$${varName}: ${arg.type}`)
    .join(', ');

/**
 * Generate the query for the specified field
 * @param curName name of the current field
 * @param curParentType parent type of the current field
 * @param curParentName parent name of the current field
 * @param argumentsDict dictionary of arguments from all fields
 * @param duplicateArgCounts map for deduping argument name collisions
 * @param crossReferenceKeyList list of the cross reference
 * @param curDepth current depth of field
 * @param fromUnion adds additional depth for unions to avoid empty child
 */
const generateQuery = (
  curName,
  curParentType,
  curParentName,
  argumentsDict = {},
  duplicateArgCounts = {},
  crossReferenceKeyList = [], // [`${curParentName}To${curName}Key`]
  curDepth = 1,
  fromUnion = false
) => {
  const field = gqlSchema.getType(curParentType).getFields()[curName];
  const curTypeName = field.type.inspect().replace(/[[\]!]/g, '');
  const curType = gqlSchema.getType(curTypeName);
  let queryStr = '';
  let childQuery = '';

  if (curType.getFields) {
    const crossReferenceKey = `${curParentName}To${curName}Key`;
    if (crossReferenceKeyList.indexOf(crossReferenceKey) !== -1 || (fromUnion ? curDepth - 2 : curDepth) > depthLimit) {
      return '';
    }
    if (!fromUnion) {
      crossReferenceKeyList.push(crossReferenceKey);
    }
    const childKeys = Object.keys(curType.getFields());
    childQuery = childKeys
      .filter((fieldName) => {
        /* Exclude deprecated fields */
        const fieldSchema = gqlSchema.getType(curType).getFields()[fieldName];
        return includeDeprecatedFields || !fieldSchema.isDeprecated;
      })
      .map(
        (cur) =>
          generateQuery(
            cur,
            curType,
            curName,
            argumentsDict,
            duplicateArgCounts,
            [...crossReferenceKeyList],
            curDepth + 1,
            fromUnion
          ).queryStr
      )
      .filter((cur) => Boolean(cur))
      .join('\n');
  }

  if (!(curType.getFields && !childQuery)) {
    queryStr = `${'    '.repeat(curDepth)}${field.name}`;
    if (field.args.length > 0) {
      const dict = getFieldArgsDict(field, duplicateArgCounts, argumentsDict);
      Object.assign(argumentsDict, dict);
      queryStr += `(${getArgsToVarsStr(dict)})`;
    }
    if (childQuery) {
      queryStr += `{\n${childQuery}\n${'    '.repeat(curDepth)}}`;
    }
  }

  /* Union types */
  if (curType.astNode && curType.astNode.kind === 'UnionTypeDefinition') {
    const types = curType.getTypes();
    if (types && types.length) {
      const indent = `${'    '.repeat(curDepth)}`;
      const fragIndent = `${'    '.repeat(curDepth + 1)}`;
      queryStr += '{\n';

      for (let i = 0, len = types.length; i < len; i++) {
        const valueTypeName = types[i];
        const valueType = gqlSchema.getType(valueTypeName);
        const unionChildQuery = Object.keys(valueType.getFields())
          .map(
            (cur) =>
              generateQuery(
                cur,
                valueType,
                curName,
                argumentsDict,
                duplicateArgCounts,
                crossReferenceKeyList,
                curDepth + 2,
                true
              ).queryStr
          )
          .filter((cur) => Boolean(cur))
          .join('\n');

        /* Exclude empty unions */
        if (unionChildQuery) {
          queryStr += `${fragIndent}... on ${valueTypeName} {\n${unionChildQuery}\n${fragIndent}}\n`;
        }
      }
      queryStr += `${indent}}`;
    }
  }
  return { queryStr, argumentsDict };
};

/**
 * Generate the query for the specified field
 * @param obj one of the root objects(Query, Mutation, Subscription)
 * @param description description of the current object
 */
const generateFile = (obj, description) => {
  let outputFolderName;
  switch (description) {
    case 'Mutation':
      outputFolderName = 'mutations';
      break;
    case 'Query':
      outputFolderName = 'queries';
      break;
    case 'Subscription':
      outputFolderName = 'subscriptions';
      break;
    default:
      console.log('[gqlg warning]:', 'description is required');
  }
  const writeFolder = path.join(destDirPath, `./${outputFolderName}`);
  try {
    fs.mkdirSync(writeFolder);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  Object.keys(obj).forEach((type) => {
    const field = gqlSchema.getType(description).getFields()[type];
    if (
      (isAdmin === 'true' && field.description !== 'admin') ||
      (isAdmin !== 'true' && field.description === 'admin')
    ) {
      return;
    }
    if (isMobile === 'true' && !(field.description && field.description.includes('mobile'))) {
      return;
    }
    if (customisedQueries.includes(type)) {
      return;
    }
    /* Only process non-deprecated queries/mutations: */
    if (includeDeprecatedFields || !field.isDeprecated) {
      const queryResult = generateQuery(type, description);
      const varsToTypesStr = getVarsToTypesStr(queryResult.argumentsDict);
      let query = queryResult.queryStr;
      query = `${description.toLowerCase()} ${type}${varsToTypesStr ? `(${varsToTypesStr})` : ''}{\n${query}\n}`;
      fs.writeFileSync(path.join(writeFolder, `./${type}.${fileExtension}`), query);
    }
  });
};

if (gqlSchema.getMutationType()) {
  generateFile(gqlSchema.getMutationType().getFields(), 'Mutation');
}

if (gqlSchema.getQueryType()) {
  generateFile(gqlSchema.getQueryType().getFields(), 'Query');
}

if (gqlSchema.getSubscriptionType()) {
  generateFile(gqlSchema.getSubscriptionType().getFields(), 'Subscription');
}
