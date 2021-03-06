// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.


import {
  JupyterLabPlugin, JupyterLab
} from '@jupyterlab/application';

import {
  Toolbar, ToolbarButton
} from '@jupyterlab/apputils';

import {
  PathExt
} from '@jupyterlab/coreutils';

import {
  DocumentRegistry
} from '@jupyterlab/docregistry';

import {
  IRenderMimeRegistry
} from '@jupyterlab/rendermime';

import {
  INotebookModel
} from '@jupyterlab/notebook';

import {
  NotebookPanel, INotebookTracker
} from '@jupyterlab/notebook';

import {
  find
} from '@phosphor/algorithm';

import {
  CommandRegistry
} from '@phosphor/commands';

import {
  Token
} from '@phosphor/coreutils';

import {
  IDisposable, DisposableDelegate
} from '@phosphor/disposable';

import {
  Menu, Widget
} from '@phosphor/widgets';

import {
  diffNotebookGit, diffNotebook, diffNotebookCheckpoint, isNbInGit
} from './actions';



/**
 * Error message if the nbdime API is unavailable.
 */
const serverMissingMsg = 'Unable to query nbdime API. Is the server extension enabled?';


const INITIAL_NETWORK_RETRY = 2; // ms


export
class NBDiffExtension implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel> {
  /**
   *
   */
  constructor(commands: CommandRegistry) {
    this.commands = commands;
  }

  /**
   * Create a new extension object.
   */
  createNew(nb: NotebookPanel, context: DocumentRegistry.IContext<INotebookModel>): IDisposable {
    // Create extension here

    // Add buttons to toolbar
    let buttons: ToolbarButton[] = [];
    let insertionPoint = -1;
    find(nb.toolbar.children(), (tbb, index) => {
      if (tbb.hasClass('jp-Notebook-toolbarCellType')) {
        insertionPoint = index;
        return true;
      }
      return false;
    });
    let i = 1;
    for (let id of [CommandIDs.diffNotebookCheckpoint, CommandIDs.diffNotebookGit]) {
      let button = Toolbar.createFromCommand(this.commands, id);
      if (button === null) {
        throw new Error('Cannot create button, command not registered!');
      }
      if (insertionPoint >= 0) {
        nb.toolbar.insertItem(insertionPoint + i++, this.commands.label(id), button);
      } else {
        nb.toolbar.addItem(this.commands.label(id), button);
      }
      buttons.push(button);
    }


    return new DisposableDelegate(() => {
      // Cleanup extension here
      for (let btn of buttons) {
        btn.dispose();
      }
    });
  }

  protected commands: CommandRegistry;
}


export
namespace CommandIDs {

  export
  const diffNotebook = 'nbdime:diff';

  export
  const diffNotebookGit = 'nbdime:diff-git';

  export
  const diffNotebookCheckpoint = 'nbdime:diff-checkpoint';

}


function addCommands(app: JupyterLab, tracker: INotebookTracker, rendermime: IRenderMimeRegistry): void {
  const { commands, shell } = app;

  // Whether we have our server extension available
  let hasAPI = true;

  /**
   * Whether there is an active notebook.
   */
  function hasWidget(): boolean {
    return tracker.currentWidget !== null;
  }

  /**
   * Whether there is an active notebook.
   */
  function baseEnabled(): boolean {
    return hasAPI && tracker.currentWidget !== null;
  }

  // This allows quicker checking, but if someone creates/removes
  // a repo during the session, this will become incorrect
  let lut_known_git: { [key: string]: boolean} = {}

  let networkRetry = INITIAL_NETWORK_RETRY;

  /**
   * Whether the notebook is in a git repository.
   */
  function hasGitNotebook(): boolean {
    if (!baseEnabled()) {
      return false;
    }

    let path = tracker.currentWidget!.context.path;
    let dir = PathExt.dirname(path);
    let known_git = lut_known_git[dir];
    if (known_git === undefined) {
      const inGitPromise = isNbInGit({path: dir});
      inGitPromise.then(inGit => {
        networkRetry = INITIAL_NETWORK_RETRY;
        lut_known_git[dir] = inGit;
        // Only update if false, since it is left enabled while waiting
        if (!inGit) {
          commands.notifyCommandChanged(CommandIDs.diffNotebookGit);
        }
      });
      inGitPromise.catch((reason) => {
        hasAPI = reason.status !== undefined && reason.status !== 404;
        setTimeout(() => {
          networkRetry *= 2;
          commands.notifyCommandChanged(CommandIDs.diffNotebook);
          commands.notifyCommandChanged(CommandIDs.diffNotebookCheckpoint);
          commands.notifyCommandChanged(CommandIDs.diffNotebookGit);
        }, networkRetry);
      });
      // Leave button enabled while unsure
      return true;
    }

    return known_git;
  }


  function erroredGen(text: string) {
    return () => {
      if (hasAPI) {
        return text;
      }
      return serverMissingMsg;
    };
  }


  commands.addCommand(CommandIDs.diffNotebook, {
    execute: args => {
      // TODO: Check args for base/remote
      // if missing, prompt with dialog.
      //let content = current.notebook;
      //diffNotebook({base, remote});
    },
    label: erroredGen('Notebook diff'),
    caption: erroredGen('Display nbdiff between two notebooks'),
    isEnabled: baseEnabled,
    icon: 'action-notebook-diff action-notebook-diff-notebooks',
    iconLabel: 'nbdiff',
  });

  commands.addCommand(CommandIDs.diffNotebookCheckpoint, {
    execute: args => {
      let current = tracker.currentWidget;
      if (!current) {
        return;
      }
      let widget = diffNotebookCheckpoint({path: current.context.path, rendermime});
      shell.addToMainArea(widget);
      if (args['activate'] !== false) {
        shell.activateById(widget.id);
      }
    },
    label: erroredGen('Notebook checkpoint diff'),
    caption: erroredGen('Display nbdiff from checkpoint to currently saved version'),
    isEnabled: baseEnabled,
    iconClass: 'fa fa-clock-o action-notebook-diff action-notebook-diff-checkpoint',
  });

  commands.addCommand(CommandIDs.diffNotebookGit, {
    execute: args => {
      let current = tracker.currentWidget;
      if (!current) {
        return;
      }
      let widget = diffNotebookGit({path: current.context.path, rendermime});
      shell.addToMainArea(widget);
      if (args['activate'] !== false) {
        shell.activateById(widget.id);
      }
    },
    label: erroredGen('Notebook Git diff'),
    caption: erroredGen('Display nbdiff from git HEAD to currently saved version'),
    isEnabled: hasGitNotebook,
    iconClass: 'fa fa-git action-notebook-diff action-notebook-diff-git',
  });
}



/**
 * The notebook diff provider.
 */
const nbDiffProvider: JupyterLabPlugin<void> = {
  id: 'jupyter.extensions.nbdime',
  requires: [INotebookTracker, IRenderMimeRegistry],
  activate: activateWidgetExtension,
  autoStart: true
};

export default nbDiffProvider;


/**
 * Activate the widget extension.
 */
function activateWidgetExtension(app: JupyterLab, tracker: INotebookTracker, rendermime: IRenderMimeRegistry): void {
  let {commands, docRegistry} = app;
  let extension = new NBDiffExtension(commands);
  docRegistry.addWidgetExtension('Notebook', extension);

  addCommands(app, tracker, rendermime);
  // Update the command registry when the notebook state changes.
  tracker.currentChanged.connect(() => {
    commands.notifyCommandChanged(CommandIDs.diffNotebookGit);
    if (tracker.size <= 1) {
      commands.notifyCommandChanged(CommandIDs.diffNotebook);
      commands.notifyCommandChanged(CommandIDs.diffNotebookCheckpoint);
    }
  });
}
