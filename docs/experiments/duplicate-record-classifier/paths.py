"""Find checkout boundaries without depending on artifact-directory depth."""
from pathlib import Path
import subprocess


def checkout_roots(anchor):
    folder=Path(anchor).resolve()
    if folder.is_file():folder=folder.parent
    root=Path(subprocess.check_output(['git','-C',str(folder),'rev-parse','--show-toplevel'],text=True).strip()).resolve()
    common=Path(subprocess.check_output(['git','-C',str(folder),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()).resolve()
    return list(dict.fromkeys([root,common.parent]))


def repository_root(anchor):return checkout_roots(anchor)[0]
