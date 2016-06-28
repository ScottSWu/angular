import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import {check, tsc} from './tsc';

import NgOptions from './options';
import {MetadataWriterHost, TsickleHost} from './compiler_host';

import * as Linter from 'tslint';

export type CodegenExtension = (ngOptions: NgOptions, program: ts.Program, host: ts.CompilerHost) =>
    Promise<void>;

export function main(project: string, basePath?: string, codegen?: CodegenExtension): Promise<any> {
  try {
    let projectDir = project;
    if (fs.lstatSync(project).isFile()) {
      projectDir = path.dirname(project);
    }
    // file names in tsconfig are resolved relative to this absolute path
    basePath = path.join(process.cwd(), basePath || projectDir);

    // read the configuration options from wherever you store them
    const {parsed, ngOptions} = tsc.readConfiguration(project, basePath);
    ngOptions.basePath = basePath;

    const host = ts.createCompilerHost(parsed.options, true);
    const program = ts.createProgram(parsed.fileNames, parsed.options, host);
    const errors = program.getOptionsDiagnostics();
    check(errors);

    if (ngOptions.skipTemplateCodegen || !codegen) {
      codegen = () => Promise.resolve(null);
    }
    return codegen(ngOptions, program, host).then(() => {
      // Create a new program since codegen files were created after making the old program
      const newProgram = ts.createProgram(parsed.fileNames, parsed.options, host, program);
      tsc.typeCheck(host, newProgram);

      // Run TSLint here
      // const tslintConfig = Linter.loadConfigurationFromPath("./tslint.json");
      const options = {
        configuration: {
          rules: {
            'enforce-header': [
              true, '/\\*[\\s\\S]*?Copyright Google Inc\\.[\\s\\S]*?\\*/',
              [
                '/**', ' * @license', ' * Copyright Google Inc. All Rights Reserved.', ' *',
                ' * Use of this source code is governed by an MIT-style license that can be',
                ' * found in the LICENSE file at https://angular.io/license', ' */\n\n'
              ].join('\n')
            ],
            'no-unused-return-value': [
              false,
              // These should go in builtins later
              ['Map', 'set'],
              ['Map', 'delete'],

              // Angular
              ['NgFor', '_bulkInsert'],
              ['ViewContainerRef', 'insert'],
              ['ViewContainerRef', 'createEmbeddedView'],
              ['ListWrapper', 'remove'],
            ],
          },
          rulesDirectory: './dist/tools/tslint'
        },
        formatter: 'prose',
        formattersDirectory: '',
        rulesDirectory: ['./dist/tools/tslint']
      };
      // Make the fixes directory
      const fixDir = path.join(process.cwd(), 'fixes');
      if (!fs.existsSync(fixDir)) {
        fs.mkdirSync(fixDir);
      }
      for (const file of parsed.fileNames) {
        const source = newProgram.getSourceFile(file).getFullText();
        const linter = new Linter(file, source, options, newProgram);
        const result = linter.lint();
        if (result.failureCount > 0) {
          // Log the failure
          console.log(result.output);

          // Accumulate fix replacements
          let replacements = result.failures.reduce((acc, f) => {
            if (f.getFixes().length > 0) {
              return acc.concat(f.getFixes()[0].replacements);
            } else {
              return acc;
            }
          }, []);

          if (replacements.length > 0) {
            // Sort in reverse order
            replacements.sort((a, b) => b.endPosition - a.endPosition);
            // Apply
            let newSource = source;
            replacements.forEach(r => {
              newSource = newSource.substring(0, r.startPosition) + r.text +
                  source.substring(r.endPosition);
            });
            // Save the new source in a different folder with the same structure
            const newPath = path.relative(process.cwd(), file);
            console.log('Creating fix ' + newPath);
            // Create all parent directories
            mkdirParent(fixDir, path.dirname(newPath));
            fs.writeFileSync(path.join(fixDir, newPath), newSource);
          }
        }
      }

      // Emit *.js with Decorators lowered to Annotations, and also *.js.map
      const tsicklePreProcessor = new TsickleHost(host, newProgram);
      tsc.emit(tsicklePreProcessor, newProgram);

      if (!ngOptions.skipMetadataEmit) {
        // Emit *.metadata.json and *.d.ts
        // Not in the same emit pass with above, because tsickle erases
        // decorators which we want to read or document.
        // Do this emit second since TypeScript will create missing directories for us
        // in the standard emit.
        const metadataWriter = new MetadataWriterHost(host, newProgram);
        tsc.emit(metadataWriter, newProgram);
      }
    });
  } catch (e) {
    return Promise.reject(e);
  }
}

// Create parent direcotries
function mkdirParent(baseDir: string, dir: string) {
  if (dir === '.' || fs.existsSync(path.join(baseDir, dir))) {
    return;
  } else {
    mkdirParent(baseDir, path.dirname(dir));
    fs.mkdirSync(path.join(baseDir, dir));
  }
}

// CLI entry point
if (require.main === module) {
  const args = require('minimist')(process.argv.slice(2));
  main(args.p || args.project || '.', args.basePath)
      .then(exitCode => process.exit(exitCode))
      .catch(e => {
        console.error(e.stack);
        console.error('Compilation failed');
        process.exit(1);
      });
}
