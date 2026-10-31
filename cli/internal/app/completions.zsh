# Source after compinit to enable botlake and bl completion.
# Only dynamic bl completion requires jq and a running lake.

# Metadata is data, never shell code. Only these fixed actions reach _arguments.
_bl_value() {
  local kind=$argv[-1]
  argv[-1]=()
  if [[ $kind == payload ]]; then
    compset -P '*=' || { _message 'name=path'; return 1; }
    _files "$@"
  elif [[ $PREFIX == @* ]]; then
    compset -P '@'
    _files "$@"
  elif [[ $kind == boolean ]]; then
    compadd "$@" true false
  else
    _message "$kind"
  fi
}

_bl_command() {
  local node=$1 discovery=$2 curcontext="$curcontext" state child specs
  shift 2
  local -a path=( "$@" ) line candidates args
  local -A opt_args

  if [[ $(command jq -r 'has("commands")' <<< "$node") == true ]]; then
    args=( '1:command:->command' '*::arguments:->arguments' )
    [[ $discovery == yes ]] || args+=( '(-h --help)'{-h,--help}'[Show command help]' )
    _arguments -C -S -A '-*' "${args[@]}"
    case $state in
      command)
        candidates=( "${(@f)$(command jq -r '
          def escape: gsub("\\\\"; "\\\\") | gsub(":"; "\\:") | gsub("[\\r\\n\\t]"; " ");
          .commands | to_entries[] | (.key | escape) + ":" + (.value.description | escape)
        ' <<< "$node")}" )
        _describe command candidates
        ;;
      arguments)
        path+=( "${(Q)words[1]}" )
        child=$(command bl "${context_flags[@]}" help --json "${path[@]}" | command jq -ec '.[0].cli') || return 1
        _bl_command "$child" "$discovery" "${path[@]}"
        ;;
    esac
    return
  fi

  # Discovery completes paths only, never a leaf command's input arguments.
  [[ $discovery == yes ]] && return 1
  specs=$(command jq -r '
    def escape:
      gsub("\\\\"; "\\\\") | gsub("(?<char>[\\[\\]:])"; "\\\(.char)") | gsub("[\\r\\n\\t]"; " ");
    def action: "_bl_value " + .type;
    ((.flags // {}) | to_entries[] |
      (if .value.multiple then "*" else "" end) +
      "--" + (.key | escape) + (if .value.type == "boolean" then "=-" else "=" end) +
      "[" + ((.value.description // "") | escape) + "]" +
      (if .value.type == "boolean" then "::" else ":" end) +
      (.value.type | escape) + ":" + (.value | action)),
    ((.positionals // []) | to_entries[] |
      (if .value.multiple then "*" else ((.key + 1) | tostring) end) +
      (if .value.required then ":" else "::" end) +
      (.value.name | escape) + ":" + (.value | action))
  ' <<< "$node") || return 1
  args=( '(-h --help)'{-h,--help}'[Show command help]' )
  [[ -n $specs ]] && args+=( "${(@f)specs}" )
  _arguments -S "${args[@]}"
}

_bl() {
  local curcontext="$curcontext" state catalog node name key ret=1
  local -a line context_flags candidates
  local -A opt_args

  _arguments -C -A '-*' \
    '--workspace=[Select a workspace or published name]:workspace:' \
    '--cwd=[Set invocation context]:directory:_directories' \
    '--worktree-root=[Override Git worktree context]:directory:_directories' \
    '--git-common-dir=[Override Git common directory]:directory:_directories' \
    '--timeout=[Override operation deadline]:duration:' \
    '--input=[Supply JSON, @file or -]:input:_bl_value json' \
    '*--payload=[Attach a named text file]:name=path:_bl_value payload' \
    '--stdin[Attach stdin as text]' \
    '--dry-run[Print the request without invoking it]' \
    '--json[Force JSON output]' \
    '(-h --help)'{-h,--help}'[Show dispatcher help]' \
    '--version[Print CLI and protocol versions]' \
    '1:operation:->operation' \
    '*::arguments:->arguments' && ret=0

  # Only selection/context flags belong on the help request: input, payloads and
  # dry-run would change its meaning. _arguments has removed global options here.
  for key in workspace cwd worktree-root git-common-dir; do
    [[ -n ${opt_args[--$key]} ]] && context_flags+=( "--$key" "${(Q)opt_args[--$key]}" )
  done

  [[ -n $state ]] || return $ret
  (( $+commands[jq] )) || { _message 'bl completion requires jq'; return 1; }
  catalog=$(command bl "${context_flags[@]}" help --json) || return 1
  node=$(command jq -ec '
    {commands: (map({key: .name, value: .cli}) | from_entries)}
  ' <<< "$catalog") || return 1

  case $state in
    operation)
      candidates=( "${(@f)$(command jq -r '
        def escape: gsub("\\\\"; "\\\\") | gsub(":"; "\\:") | gsub("[\\r\\n\\t]"; " ");
        .[] | (.name | escape) + ":" + (.cli.description | escape)
      ' <<< "$catalog")}" )
      candidates+=( 'help:Discover commands' 'about:Read explanations' 'prime:Read runbooks' )
      _describe operation candidates
      ;;
    arguments)
      name=${(Q)words[1]}
      if [[ $name == (help|about|prime) ]]; then
        # --json is recognized only immediately after the discovery operation.
        _arguments -C -A '-*' '--json[Force JSON output]' '1:operation:->operation' '*::arguments:->arguments'
        if [[ $state == operation ]]; then
          _bl_command "$node" yes
        elif [[ $state == arguments ]]; then
          name=${(Q)words[1]}
          node=$(command bl "${context_flags[@]}" help --json "$name" | command jq -ec '.[0].cli') || return 1
          _bl_command "$node" yes "$name"
        fi
      else
        node=$(command bl "${context_flags[@]}" help --json "$name" | command jq -ec '.[0].cli') || return 1
        _bl_command "$node" no "$name"
      fi
      ;;
  esac
}

_botlake() {
  local curcontext="$curcontext" state ret=1
  local -a line args
  local -A opt_args
  local workspace='--workspace=[Select a workspace or published name]:workspace:_directories'
  local -a help=( '(-h --help)'{-h,--help}'[Show command help]' )

  _arguments -C -A '-*' \
    '--help[Show dispatcher help]' \
    '--version[Print CLI and protocol versions]' \
    '1:command:((
      init\:"Initialize workspace configuration"
      start\:"Run the foreground supervisor"
      status\:"Inspect supervisor status"
      stop\:"Stop the supervisor"
      restart-host\:"Restart the host"
      host-status\:"Inspect host status"
      lake\:"Manage workspace lakes"
      bin\:"List, build or run extension executables"
      completions\:"Generate shell completion"
      help\:"Show dispatcher help"
    ))' \
    '*::arguments:->arguments' && ret=0
  [[ $state == arguments ]] || return $ret

  case ${(Q)words[1]} in
    init)
      _arguments -S -A '-*' "${help[@]}" \
        '--workspace=[Workspace directory]:directory:_directories' \
        '--name=[Published workspace name]:name:'
      ;;
    completions)
      _arguments '1:shell:(zsh)'
      ;;
    lake)
      _arguments -C -A '-*' \
        '1:action:(start restart stop status list eval)' \
        '*::arguments:->lake'
      [[ $state == lake ]] || return
      case ${(Q)words[1]} in
        start|restart|stop|status)
          _arguments -S -A '-*' "$workspace"
          ;;
        eval)
          _arguments -S -A '-*' "${help[@]}" "$workspace" \
            '--cwd=[Set evaluation context]:directory:_directories' \
            '--timeout=[Override evaluation deadline]:duration:' \
            '1:code or @file or -:_bl_value string'
          ;;
      esac
      ;;
    bin)
      _arguments -C -A '-*' "${help[@]}" "$workspace" \
        '1:action:(list build run help)' \
        '*::arguments:->bin'
      [[ $state == bin ]] || return
      args=( "${help[@]}" "$workspace" )
      case ${(Q)words[1]} in
        build) args+=( '1:executable:_message executable' ) ;;
        run) args+=( '1:executable:_message executable' '*:arguments:_files' ) ;;
        list) ;;
        *) return 1 ;;
      esac
      _arguments -S -A '-*' "${args[@]}"
      ;;
  esac
}

compdef _bl bl
compdef _botlake botlake
